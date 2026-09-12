// Pieces used by BOTH answer paths — the single-shot `ask()` and the tool-using `runAgent()`:
// the result shape, the numbered-source registry, the answer schema, the citation gate
// and the questions_log write. Keeping them here is what makes the two paths comparable:
// the agent cannot accidentally relax a guarantee that `ask()` enforces.

import { z } from "zod";
import { nowIso, run } from "../db.js";
import type { Candidate, FactRow } from "./retrieve.js";

export const AnswerSchema = z.object({
  status: z.enum(["answered", "no_reliable_answer"]),
  mode: z.enum(["factual", "synthesis"]),
  answer: z.string(),
  as_of: z.string().nullable(),
  citations: z.array(z.number().int()),
  confidence: z.number().min(0).max(1),
});
export type Answer = z.infer<typeof AnswerSchema>;

export interface Source {
  n: number; url: string; title: string; published_at: string | null;
  effective_date?: string | null; date_kind?: "published" | "live" | "undated";
  tier: number; domain: string; quote: string;
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
  items?: { n: number; title: string; url: string; date: string | null; score?: number }[];
  error?: string;
}

export interface AskResult {
  question: string;
  status: "answered" | "no_reliable_answer";
  mode: "factual" | "synthesis" | null;
  answer: string;
  as_of: string | null;
  confidence: number;
  sources: Source[];
  gate: "none" | "gate1_no_evidence" | "gate2_no_valid_citations" | "gate3_ungrounded_number" | "model_abstained" | "model_error";
  /** Numbers gate 3 blocked (set only when the gate fired). */
  ungrounded_numbers?: string[];
  /** Every numeric literal the tools put in front of the model — lets the eval re-derive gate 3 itself. */
  evidence_numbers?: string[];
  error?: string;
  steps?: Step[];
  trace: {
    engine?: "single-shot" | "agent";
    fts_query: string; vector_used: boolean;
    candidates: Candidate[]; selected: Candidate[]; facts: FactRow[];
    model: string | null; usage: any; cost_usd: number; latency_ms: number;
    instructions_in_context: number;
    config: { ranking: any; retrieval: any; filters: any; gates: any };
  };
}

export const esc = (s: string) => (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The numbered list of sources the model is allowed to cite. Numbers are handed out once
 * and never reused, so `[7]` means the same thing on step 2 and on step 6 of an agent run.
 * Re-adding the same URL returns the existing number instead of a duplicate.
 */
export class SourceRegistry {
  readonly sources: Source[] = [];
  /** Raw rows behind the numbers, so the agent's trace shows the same ranking detail as `ask()`. */
  readonly chunks: Candidate[] = [];
  readonly factRows: FactRow[] = [];
  /**
   * Every piece of text a tool actually handed to the model this run, verbatim.
   * Gate 3 checks the answer's numbers against this, so it has to be the text the model
   * saw — not the 280-char `quote` we keep for display.
   */
  readonly evidence: string[] = [];

  /** Record text that was put in front of the model (tool bodies that are not chunks or facts). */
  note(...texts: (string | null | undefined)[]) {
    for (const t of texts) if (t) this.evidence.push(t);
  }

  add(s: Omit<Source, "n">): Source {
    const hit = this.sources.find((x) => x.url === s.url && x.kind === s.kind && x.quote === s.quote);
    if (hit) return hit;
    const created = { ...s, n: this.sources.length + 1 };
    this.sources.push(created);
    return created;
  }

  /** Numbered `<source>` blocks for a set of retrieved chunks (tagged data, never instructions). */
  addChunks(cands: Candidate[]): { source: Source; block: string }[] {
    for (const c of cands) if (!this.chunks.some((x) => x.chunk_id === c.chunk_id)) this.chunks.push(c);
    return cands.map((c) => {
      this.note(c.text, c.title, c.published_at, c.effective_date);
      const source = this.add({
        url: c.url, title: c.title, published_at: c.published_at, effective_date: c.effective_date, date_kind: c.date_kind,
        tier: c.tier, domain: c.domain, quote: c.text.slice(0, 280), kind: "chunk", score: c.score,
      });
      const dateAttr = c.date_kind === "published" ? `published="${c.published_at}"`
        : c.date_kind === "live" ? `live_page_as_of="${c.effective_date}"` : `published="unknown"`;
      const note = c.ai_directed ? ' note="page written for AI assistants; self-declaration"' : "";
      return { source, block: `<source id="${source.n}" url="${c.url}" title="${esc(c.title)}" ${dateAttr} tier="${c.tier}"${note}>\n${c.text}\n</source>` };
    });
  }

  /** Fact-ledger rows. A row reuses the source number of its document when that page is already cited. */
  addFacts(facts: FactRow[]): { source: Source; block: string }[] {
    for (const f of facts) if (!this.factRows.some((x) => x.id === f.id)) this.factRows.push(f);
    return facts.map((f) => {
      this.note(f.value, f.quote, f.as_of, f.published_at);
      const source = this.add({
        url: f.url, title: f.title, published_at: f.published_at, tier: f.tier,
        domain: safeHost(f.url), quote: f.quote, kind: "fact",
      });
      return { source, block: `<fact key="${f.key}" value="${esc(f.value)}" as_of="${f.as_of ?? "unknown"}" source="${source.n}" tier="${f.tier}">${esc(f.quote)}</fact>` };
    });
  }

  has(n: number) { return this.sources.some((s) => s.n === n); }
}

export const safeHost = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

/**
 * Gate 2, in code rather than in the prompt: an answer may only cite source numbers that a
 * tool actually returned during this run. Unknown numbers are dropped; if nothing survives
 * and citations are required, the caller downgrades the answer to "no reliable answer".
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
const NUMBER_RE = /\d[\d.,]*/g;

/** "1,600,000" → "1600000". Thousands separators only; the decimal point survives. */
export function stripGroupSeparators(s: string): string {
  let out = s, prev = "";
  while (out !== prev) { prev = out; out = out.replace(/(\d)[,\u0020\u00a0\u202f](\d{3})(?!\d)/g, "$1$2"); }
  return out;
}

/** Numeric literals a reader would treat as claims: citation markers and URLs excluded. */
export function numericLiterals(text: string): string[] {
  const cleaned = (text ?? "").replace(URL_RE, " ").replace(CITATION_RE, " ");
  return [...cleaned.matchAll(NUMBER_RE)].map((m) => m[0].replace(/[.,]+$/, "")).filter(Boolean);
}

const valueOf = (lit: string): number | null => {
  const n = Number(stripGroupSeparators(lit).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Numbers in `answer` that appear nowhere in `evidence`. Matching is deliberately generous —
 * the point is to catch numbers with no provenance at all, not to police rounding:
 *   • literal match after removing thousands separators ("1.6M" ⊂ "1.6M+ delegators")
 *   • same value at a different scale ("1.6 million" vs "1,600,000")
 * A number that survives both is one no tool ever returned.
 */
export function ungroundedNumbers(answer: string, evidence: string[]): string[] {
  const evText = stripGroupSeparators(evidence.join("\n"));
  const evValues = new Set<number>();
  for (const lit of numericLiterals(evText)) { const v = valueOf(lit); if (v !== null) evValues.add(v); }
  const scales = [1e2, 1e3, 1e6, 1e9, 1e12];
  const bad: string[] = [];
  for (const lit of new Set(numericLiterals(answer))) {
    const norm = stripGroupSeparators(lit);
    if (evText.includes(norm)) continue;
    const v = valueOf(lit);
    if (v === null || evValues.has(v)) continue;
    if (scales.some((s) => evValues.has(v * s) || evValues.has(v / s))) continue;
    bad.push(lit);
  }
  return bad;
}

/** Stamps latency, writes the row `questions_log` (and therefore the eval and the UI) reads, returns the result. */
export function logQuestion(res: AskResult, t0: number, opts: { error?: boolean } = {}): AskResult {
  res.trace.latency_ms = Date.now() - t0;
  run("INSERT INTO questions_log (ts, question, status, mode, cost_usd, latency_ms, response) VALUES (?,?,?,?,?,?,?)",
    nowIso(), res.question, opts.error ? "error" : res.status, res.mode, res.trace.cost_usd, res.trace.latency_ms,
    JSON.stringify({ ...res, evidence_numbers: undefined, trace: { ...res.trace, candidates: undefined } }));
  return res;
}
