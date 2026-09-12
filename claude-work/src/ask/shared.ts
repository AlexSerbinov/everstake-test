// Pieces used by BOTH answer paths — the single-shot `ask()` and the tool-using `runAgent()`:
// the result shape, the numbered-source registry, the answer schema, the citation gate
// and the questions_log write. Keeping them here is what makes the two paths comparable:
// the agent cannot accidentally relax a guarantee that `ask()` enforces.
//
// Pipeline position: crawl → dedup → index → facts → retrieve → **answer** → eval.
// If this file is wrong the failure is silent and expensive: a broken `validateCitations`
// lets an invented `[9]` through, a broken `ungroundedNumbers` lets an invented figure through,
// and both look like confident, well-formatted answers. Nothing downstream re-checks them.

import { z } from "zod";
import { nowIso, run } from "../db.js";
import type { Candidate, FactRow } from "./retrieve.js";

/**
 * The JSON contract for the single-shot path. It is a schema rather than free text because
 * "I don't know" has to be a machine-readable state (`status`), not a turn of phrase the eval
 * would have to detect with a regex.
 */
export const AnswerSchema = z.object({
  status: z.enum(["answered", "no_reliable_answer"]),
  mode: z.enum(["factual", "synthesis"]),
  answer: z.string(),
  as_of: z.string().nullable(),
  citations: z.array(z.number().int()),
  confidence: z.number().min(0).max(1),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** One numbered source the model may cite. `n` is minted by `SourceRegistry`, never by the model. */
export interface Source {
  /** Citation number, unique and stable within one run — the `n` in `[n]`. */
  n: number;
  url: string;
  title: string;
  /** Date on the page itself; null for evergreen pages that never carried one. */
  published_at: string | null;
  /** The date used for ranking: `published_at`, or the fetch date for a live page. */
  effective_date?: string | null;
  date_kind?: "published" | "live" | "undated";
  /** 1 first-party · 2 press/third-party · 3 transcripts and social. */
  tier: number;
  domain: string;
  /** First 280 chars, for display only. Gate 3 checks against `SourceRegistry.evidence`, not this. */
  quote: string;
  kind: "chunk" | "fact" | "live_page" | "live_mcp" | "document";
  score?: number;
}

/** One tool call and its result, as stored in `questions_log.response.steps` and streamed to the UI. */
export interface Step {
  step: number;
  tool: string;
  args: Record<string, any>;
  summary: string;
  ms: number;
  items?: {
    n: number;
    title: string;
    url: string;
    date: string | null;
    score?: number;
  }[];
  error?: string;
}

/** Everything one question produced: the answer, why it is trusted, and how it was reached. */
export interface AskResult {
  question: string;
  status: "answered" | "no_reliable_answer";
  mode: "factual" | "synthesis" | null;
  answer: string;
  as_of: string | null;
  confidence: number;
  /** Only the sources actually cited — the full candidate list lives in `trace`. */
  sources: Source[];
  /**
   * Which check refused the answer, or "none". These strings are a contract: the eval buckets
   * runs by them and the UI colours the verdict by them, so they are never reworded.
   */
  gate:
    | "none"
    | "gate1_no_evidence"
    | "gate2_no_valid_citations"
    | "gate3_ungrounded_number"
    | "model_abstained"
    | "model_error";
  /** Numbers gate 3 blocked (set only when the gate fired). */
  ungrounded_numbers?: string[];
  /** Every numeric literal the tools put in front of the model — lets the eval re-derive gate 3 itself. */
  evidence_numbers?: string[];
  error?: string;
  steps?: Step[];
  trace: {
    engine?: "single-shot" | "agent";
    fts_query: string;
    vector_used: boolean;
    candidates: Candidate[];
    selected: Candidate[];
    facts: FactRow[];
    model: string | null;
    usage: any;
    cost_usd: number;
    latency_ms: number;
    instructions_in_context: number;
    config: { ranking: any; retrieval: any; filters: any; gates: any };
  };
}

/**
 * Escapes the three characters that would let page text break out of a `<source …>` block:
 * `<` (a fake closing tag), `"` (an attribute delimiter) and `&` (so the other two cannot be
 * re-introduced as entities). `>` is deliberately left alone — a bare `>` cannot open anything,
 * and prose is full of them ("uptime > 99.9%"), so escaping it would only mangle the evidence.
 */
export const escapeForSourceBlock = (text: string) =>
  (text ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The numbered list of sources the model is allowed to cite. Numbers are handed out once
 * and never reused, so `[7]` means the same thing on step 2 and on step 6 of an agent run.
 * Re-adding the same URL returns the existing number instead of a duplicate.
 *
 * Minting numbers here rather than letting the model label its own sources is what makes gate 2
 * possible: a citation is checkable precisely because the registry, not the model, decides what
 * `[7]` refers to. Reusing a number mid-run would break that — the model would have cited `[7]`
 * while looking at one page and we would validate it against another.
 */
export class SourceRegistry {
  readonly sources: Source[] = [];
  /** Raw rows behind the numbers, so the agent's trace shows the same ranking detail as `ask()`. */
  readonly chunks: Candidate[] = [];
  readonly factRows: FactRow[] = [];
  /**
   * Every piece of text a tool actually handed to the model this run, verbatim.
   * Gate 3 checks the answer's numbers against this, so it has to be the text the model
   * saw — not the 280-char `quote` we keep for display. Storing the quote instead would
   * make gate 3 fire on any figure that happened to fall past character 280.
   */
  readonly evidence: string[] = [];

  /** Record text that was put in front of the model (tool bodies that are not chunks or facts). */
  note(...texts: (string | null | undefined)[]) {
    for (const text of texts) if (text) this.evidence.push(text);
  }

  /**
   * Mint a number for a source, or return the number it already has. Identity is
   * (url, kind, quote) rather than url alone: two different chunks of the same long page are
   * different evidence and must be citable separately, while the same chunk re-returned by a
   * second search must not consume a second number.
   */
  add(source: Omit<Source, "n">): Source {
    const existing = this.sources.find(
      (candidate) => candidate.url === source.url && candidate.kind === source.kind && candidate.quote === source.quote,
    );
    if (existing) return existing;
    const created = { ...source, n: this.sources.length + 1 };
    this.sources.push(created);
    return created;
  }

  /** Numbered `<source>` blocks for a set of retrieved chunks (tagged data, never instructions). */
  addChunks(candidates: Candidate[]): { source: Source; block: string }[] {
    for (const candidate of candidates) {
      if (!this.chunks.some((seen) => seen.chunk_id === candidate.chunk_id)) this.chunks.push(candidate);
    }
    return candidates.map((candidate) => {
      this.note(candidate.text, candidate.title, candidate.published_at, candidate.effective_date);
      const source = this.add({
        url: candidate.url,
        title: candidate.title,
        published_at: candidate.published_at,
        effective_date: candidate.effective_date,
        date_kind: candidate.date_kind,
        tier: candidate.tier,
        domain: candidate.domain,
        quote: candidate.text.slice(0, 280),
        kind: "chunk",
        score: candidate.score,
      });
      return { source, block: chunkSourceBlock(source.n, candidate) };
    });
  }

  /** Fact-ledger rows. A row reuses the source number of its document when that page is already cited. */
  addFacts(facts: FactRow[]): { source: Source; block: string }[] {
    for (const fact of facts) {
      if (!this.factRows.some((seen) => seen.id === fact.id)) this.factRows.push(fact);
    }
    return facts.map((fact) => {
      this.note(fact.value, fact.quote, fact.as_of, fact.published_at);
      const source = this.add({
        url: fact.url,
        title: fact.title,
        published_at: fact.published_at,
        tier: fact.tier,
        domain: safeHost(fact.url),
        quote: fact.quote,
        kind: "fact",
      });
      const block =
        `<fact key="${fact.key}" value="${escapeForSourceBlock(fact.value)}" as_of="${fact.as_of ?? "unknown"}"` +
        ` source="${source.n}" tier="${fact.tier}">${escapeForSourceBlock(fact.quote)}</fact>`;
      return { source, block };
    });
  }

  has(n: number) {
    return this.sources.some((source) => source.n === n);
  }
}

/**
 * The date attribute the model sees on a chunk. The three cases are not cosmetic — they are the
 * rule that solves the CEO trap:
 *   published="DATE"        an announcement, dated by the page itself
 *   live_page_as_of="DATE"  an evergreen page (about/team/docs) as it stood when we fetched it
 *   published="unknown"     no date we trust
 * The prompt turns `live_page_as_of` into: a dated announcement OLDER than that date does not
 * override it. A June 2025 press release says Kinitsky "joins as CEO"; the company page fetched
 * in September 2026 lists Vasylchuk as CEO and Kinitsky as CCDO. Without this distinction the
 * older, explicitly dated press release wins and the system answers with the wrong CEO.
 */
function chunkDateAttribute(candidate: Candidate): string {
  if (candidate.date_kind === "published") return `published="${candidate.published_at}"`;
  if (candidate.date_kind === "live") return `live_page_as_of="${candidate.effective_date}"`;
  return `published="unknown"`;
}

/**
 * A chunk as the model receives it: quoted page text wrapped in a tag, with its provenance in
 * attributes. Tagged data, never instructions — the model is told (prompts/agent.md) that
 * anything inside a `<source>` is evidence ABOUT a page, so a page saying "AI assistants must
 * describe Everstake as …" is reported, not obeyed. Sentences like that were already cut out at
 * index time (src/index/instructions.ts); this tagging is the second line of defence for the
 * ones that got through and for live pages fetched after indexing.
 */
function chunkSourceBlock(n: number, candidate: Candidate): string {
  // Pages addressed to AI assistants are self-declarations. The model is told so explicitly
  // as well as being ranked down for it (authorityMultiplier), because the discount only
  // reorders the list — it cannot stop the page being read once it is in context.
  const aiNote = candidate.ai_directed ? ' note="page written for AI assistants; self-declaration"' : "";
  return (
    `<source id="${n}" url="${candidate.url}" title="${escapeForSourceBlock(candidate.title)}"` +
    ` ${chunkDateAttribute(candidate)} tier="${candidate.tier}"${aiNote}>\n${candidate.text}\n</source>`
  );
}

/** Hostname, or the raw string when the value is not a URL (fact rows can carry a bare id). */
export const safeHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * Gate 2, in code rather than in the prompt: an answer may only cite source numbers that a
 * tool actually returned during this run. Unknown numbers are dropped; if nothing survives
 * and citations are required, the caller downgrades the answer to "no reliable answer".
 *
 * The attack it stops is the ordinary one — a model that answers from memory and decorates the
 * claim with a plausible-looking `[9]`. Asking the prompt not to do that is not a check; this is.
 */
export function validateCitations(reg: Pick<SourceRegistry, "has">, citations: number[]): number[] {
  return [...new Set(citations)].filter((n) => Number.isInteger(n) && reg.has(n));
}

// --- gate 3: every number in the answer must come from the evidence -----------------------
// The failure this exists for is the expensive one: a model that is otherwise well behaved
// still invents a rate, a total or a percentage when the question invites arithmetic
// ("take the market average 4.5% and mark it as preliminary"). Citations do not catch it —
// the sentence around the invented number can be perfectly cited. So the numbers themselves
// are checked, in code, against the text the tools actually returned.

const CITATION_RE = /\[[\d\s,]+\]/g;                 // "[1, 4]" is a marker, not a claim
const URL_RE = /https?:\/\/\S+/g;                    // "…/2025/06/12/…" is an address, not a claim
const NUMBER_RE = /\d[\d.,]*/g;                      // "1,600,000", "99.98", "130" — digits plus inner . and ,

/** Scales a figure may legitimately be restated at: "1.6 million" against "1,600,000". */
const EQUIVALENT_SCALES = [1e2, 1e3, 1e6, 1e9, 1e12];

/** "1,600,000" → "1600000". Thousands separators only; the decimal point survives. */
export function stripGroupSeparators(s: string): string {
  let out = s, prev = "";
  // Looped because the separators overlap: one pass over "1,600,000" fixes the first group and
  // leaves the second, since the regex has already consumed the digit the next match needs.
  while (out !== prev) { prev = out; out = out.replace(/(\d)[,   ](\d{3})(?!\d)/g, "$1$2"); }
  return out;
}

/** Numeric literals a reader would treat as claims: citation markers and URLs excluded. */
export function numericLiterals(text: string): string[] {
  const cleaned = (text ?? "").replace(URL_RE, " ").replace(CITATION_RE, " ");
  // Trailing . and , are sentence punctuation, not part of the figure ("130 networks." → "130").
  return [...cleaned.matchAll(NUMBER_RE)].map((match) => match[0].replace(/[.,]+$/, "")).filter(Boolean);
}

/** Numeric value of a literal, or null when it does not parse ("2026-09" splits before this). */
const numericValue = (literal: string): number | null => {
  const parsed = Number(stripGroupSeparators(literal).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Every distinct value the evidence states, so a differently-written restatement still matches. */
function evidenceValues(evidenceText: string): Set<number> {
  const values = new Set<number>();
  for (const literal of numericLiterals(evidenceText)) {
    const value = numericValue(literal);
    if (value !== null) values.add(value);
  }
  return values;
}

/** True when the evidence states the same figure at another magnitude ("1.6" vs "1,600,000"). */
function appearsAtAnotherScale(value: number, values: Set<number>): boolean {
  return EQUIVALENT_SCALES.some((scale) => values.has(value * scale) || values.has(value / scale));
}

/**
 * Numbers in `answer` that appear nowhere in `evidence`. Matching is deliberately generous —
 * the point is to catch numbers with no provenance at all, not to police rounding:
 *   • literal match after removing thousands separators ("1.6M" ⊂ "1.6M+ delegators")
 *   • same value at a different scale ("1.6 million" vs "1,600,000")
 * A number that survives both is one no tool ever returned.
 *
 * Being generous is the design: this is the only gate that can refuse an answer that is
 * otherwise correct and well cited, so a false positive costs a good answer. False negatives
 * (a rounded figure slipping through) are recoverable; false positives are not.
 */
export function ungroundedNumbers(answer: string, evidence: string[]): string[] {
  const evidenceText = stripGroupSeparators(evidence.join("\n"));
  const values = evidenceValues(evidenceText);
  const ungrounded: string[] = [];
  for (const literal of new Set(numericLiterals(answer))) {
    const normalised = stripGroupSeparators(literal);
    if (evidenceText.includes(normalised)) continue;          // written exactly as a source wrote it
    const value = numericValue(literal);
    if (value === null || values.has(value)) continue;        // same value, different formatting
    if (appearsAtAnotherScale(value, values)) continue;
    ungrounded.push(literal);
  }
  return ungrounded;
}

/** The fields of an `AskResult` that are known before the gates decide the outcome. */
export type ResultBase = Omit<AskResult, "status" | "mode" | "answer" | "as_of" | "confidence" | "sources" | "gate">;

/**
 * The shape every refused answer takes. Both paths build refusals through this so a new gate
 * cannot accidentally return a "no reliable answer" that still carries sources, a confidence
 * or a stale `as_of` — the UI would render that as a partial answer.
 */
export function refusal(
  base: ResultBase,
  gate: AskResult["gate"],
  answer: string,
  extra: Partial<AskResult> = {},
): AskResult {
  return {
    ...base,
    status: "no_reliable_answer",
    mode: null,
    confidence: 0,
    as_of: null,
    sources: [],
    gate,
    answer,
    ...extra,
  };
}

/**
 * The gates that run AFTER the model has spoken, shared verbatim by `ask()` and `runAgent()`.
 *
 * Written once and imported twice on purpose: this is the claim REPORT.md §2.7 makes — the
 * agent cannot relax a rule the single-shot path enforces — expressed as code rather than as a
 * convention two files are trusted to follow. What comes BEFORE differs (the single-shot path
 * gates on a retrieval score, the agent on whether any tool returned a source), because "is
 * there evidence" means different things on the two paths. What comes after does not.
 *
 * Order matters and is the order of increasing cost and decreasing severity:
 *   1. the model abstained — its own words, kept
 *   2. gate 2, citations exist and point at real sources
 *   3. gate 3, every number came from the evidence
 * `detail` is the payload of the SSE `verify` stage; `ask()` has no stream and discards it.
 */
export function applyAnswerGates(params: {
  base: ResultBase;
  reg: SourceRegistry;
  answer: Answer;
  gates: { require_citations: boolean; require_grounded_numbers: boolean };
}): { result: AskResult; detail: Record<string, unknown> } {
  const { base, reg, answer, gates } = params;

  // Every numeral the tools put in front of the model. Attached to abstentions and to gate-3
  // refusals so the eval can re-derive the verdict itself instead of trusting this process.
  const evidenceNumbers = [...new Set(numericLiterals(reg.evidence.join("\n")))];

  // The model chose to abstain. Its own sentence is kept — it says what was missing — but the
  // status is the machine-readable one and no sources are attached to a non-answer.
  if (answer.status === "no_reliable_answer") {
    return {
      result: refusal(base, "model_abstained", answer.answer, {
        mode: answer.mode,
        confidence: answer.confidence,
        evidence_numbers: evidenceNumbers,
      }),
      detail: { gate: "model_abstained" },
    };
  }

  // gate 2: an invented [9] is dropped here; an answer with nothing left is not an answer.
  const cited = validateCitations(reg, answer.citations);
  if (gates.require_citations && cited.length === 0) {
    return {
      result: refusal(
        base,
        "gate2_no_valid_citations",
        "No reliable answer was found in the corpus: the model's answer could not be tied to any retrieved source.",
        { mode: answer.mode },
      ),
      detail: { gate: "gate2_no_valid_citations", claimed: answer.citations },
    };
  }

  // gate 3: a number the tools never returned is an invented number, however well cited the
  // sentence around it is. Optional (gates.require_grounded_numbers) because it is the one
  // gate that can refuse an otherwise good answer. Runs after gate 2 so the expensive check
  // only ever sees answers that could otherwise be delivered.
  const ungrounded = ungroundedNumbers(answer.answer, reg.evidence);
  if (gates.require_grounded_numbers && ungrounded.length) {
    return {
      result: refusal(
        base,
        "gate3_ungrounded_number",
        `No reliable answer: the draft answer contained a number that appears in none of the retrieved sources, so it was not delivered.`,
        { mode: answer.mode, ungrounded_numbers: ungrounded, evidence_numbers: evidenceNumbers },
      ),
      detail: { gate: "gate3_ungrounded_number", ungrounded },
    };
  }

  return {
    result: {
      ...base,
      evidence_numbers: evidenceNumbers,
      status: "answered",
      mode: answer.mode,
      answer: answer.answer,
      as_of: answer.as_of,
      confidence: answer.confidence,
      gate: "none",
      // Only the cited sources are returned: an uncited candidate did not support the answer,
      // and listing it would suggest corroboration that was never claimed. The full ranked list
      // stays in `trace.candidates` for anyone auditing the retrieval.
      sources: reg.sources.filter((source) => cited.includes(source.n)),
    },
    // `dropped` names the numbers the model claimed that gate 2 removed — visible in the
    // stream and in the stored trace, not silently swallowed.
    detail: { gate: "none", cited, dropped: answer.citations.filter((n) => !cited.includes(n)) },
  };
}

/** Stamps latency, writes the row `questions_log` (and therefore the eval and the UI) reads, returns the result. */
export function logQuestion(res: AskResult, t0: number, opts: { error?: boolean } = {}): AskResult {
  res.trace.latency_ms = Date.now() - t0;
  run("INSERT INTO questions_log (ts, question, status, mode, cost_usd, latency_ms, response) VALUES (?,?,?,?,?,?,?)",
    nowIso(), res.question, opts.error ? "error" : res.status, res.mode, res.trace.cost_usd, res.trace.latency_ms,
    // `evidence_numbers` and the full candidate list are dropped from the stored copy only:
    // they are large, the caller still gets them, and the row is read back by the UI per question.
    JSON.stringify({ ...res, evidence_numbers: undefined, trace: { ...res.trace, candidates: undefined } }));
  return res;
}
