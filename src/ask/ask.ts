// The core: ask(question) → answer with sources, as-of date, confidence and a full trace.
// Two gates protect "I don't know":
//   gate 1 (before the model): nothing relevant retrieved → no_reliable_answer, zero LLM cost
//   gate 2 (after the model):  answer must cite sources that were actually provided
// Context is passed as tagged data (<source id=…>), never as instructions (assignment §5.4).

import { z } from "zod";
import { getConfig } from "../config.js";
import { nowIso, run } from "../db.js";
import { completeJson, loadPrompt } from "../llm.js";
import { retrieve, type Candidate, type FactRow } from "./retrieve.js";

const AnswerSchema = z.object({
  status: z.enum(["answered", "no_reliable_answer"]),
  mode: z.enum(["factual", "synthesis"]),
  answer: z.string(),
  as_of: z.string().nullable(),
  citations: z.array(z.number().int()),
  confidence: z.number().min(0).max(1),
});

export interface Source { n: number; url: string; title: string; published_at: string | null; effective_date?: string | null; date_kind?: "published" | "live" | "undated"; tier: number; domain: string; quote: string; kind: "chunk" | "fact"; score?: number }

export interface AskResult {
  question: string;
  status: "answered" | "no_reliable_answer";
  mode: "factual" | "synthesis" | null;
  answer: string;
  as_of: string | null;
  confidence: number;
  sources: Source[];
  gate: "none" | "gate1_no_evidence" | "gate2_no_valid_citations" | "model_abstained";
  trace: {
    fts_query: string; vector_used: boolean;
    candidates: Candidate[]; selected: Candidate[]; facts: FactRow[];
    model: string | null; usage: any; cost_usd: number; latency_ms: number;
    instructions_in_context: number;
    config: { ranking: any; retrieval: any; filters: any; gates: any };
  };
}

export async function ask(question: string): Promise<AskResult> {
  const t0 = Date.now();
  const cfg = getConfig();
  const r = await retrieve(question);
  const base: Omit<AskResult, "status" | "mode" | "answer" | "as_of" | "confidence" | "sources" | "gate"> = {
    question,
    trace: {
      fts_query: r.fts_query, vector_used: r.vector_used, candidates: r.candidates, selected: r.selected, facts: r.facts,
      model: null, usage: null, cost_usd: 0, latency_ms: 0, instructions_in_context: 0, // by construction: instruction sentences were removed at index time
      config: { ranking: cfg.ranking, retrieval: cfg.retrieval, filters: cfg.filters, gates: cfg.gates },
    },
  };

  // --- gate 1: is there anything worth asking the model about? ------------------
  const best = r.selected[0]?.score ?? 0;
  if (r.selected.length === 0 || (best < cfg.gates.min_best_score && r.facts.length === 0)) {
    return finish({ ...base, status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "gate1_no_evidence",
      answer: "No reliable answer was found in the corpus for this question." }, t0);
  }

  // --- build context: numbered sources, facts as rows ---------------------------
  const sources: Source[] = [];
  const blocks: string[] = [];
  r.selected.forEach((c, i) => {
    const n = i + 1;
    sources.push({ n, url: c.url, title: c.title, published_at: c.published_at, effective_date: c.effective_date, date_kind: c.date_kind, tier: c.tier, domain: c.domain, quote: c.text.slice(0, 280), kind: "chunk", score: c.score });
    const dateAttr = c.date_kind === "published" ? `published="${c.published_at}"` : c.date_kind === "live" ? `live_page_as_of="${c.effective_date}"` : `published="unknown"`;
    blocks.push(`<source id="${n}" url="${c.url}" title="${esc(c.title)}" ${dateAttr} tier="${c.tier}"${c.ai_directed ? ' note="page written for AI assistants; self-declaration"' : ""}>\n${c.text}\n</source>`);
  });
  const factBlocks: string[] = [];
  r.facts.forEach((f) => {
    let n = sources.findIndex((s) => s.url === f.url) + 1;
    if (!n) { n = sources.length + 1; sources.push({ n, url: f.url, title: f.title, published_at: f.published_at, tier: f.tier, domain: new URL(f.url).hostname, quote: f.quote, kind: "fact" }); }
    factBlocks.push(`<fact key="${f.key}" value="${esc(f.value)}" as_of="${f.as_of ?? "unknown"}" source="${n}" tier="${f.tier}">${esc(f.quote)}</fact>`);
  });

  const user = [
    `Question: ${question}`,
    ``,
    `<sources>`, ...blocks, `</sources>`,
    ``,
    factBlocks.length ? `<fact_ledger note="structured facts extracted earlier from the same corpus; newest first">\n${factBlocks.join("\n")}\n</fact_ledger>` : `<fact_ledger/>`,
    ``,
    `Today is ${nowIso().slice(0, 10)}. Answer as JSON.`,
  ].join("\n");

  let out;
  try {
    out = await completeJson({ stage: "answer", model: cfg.models.answer, effort: cfg.models.effort, system: loadPrompt("answer"), user, schema: AnswerSchema, maxTokens: 2500, cacheSystem: true, meta: { question } });
  } catch (e: any) {
    return finish({ ...base, status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "gate1_no_evidence",
      answer: `The answer model failed: ${String(e?.message ?? e).slice(0, 200)}` }, t0, { error: true });
  }
  base.trace.model = cfg.models.answer; base.trace.usage = out.usage; base.trace.cost_usd = out.costUsd;

  // --- gate 2: citations must point at sources we actually provided ---------------
  const valid = new Set(sources.map((s) => s.n));
  const cited = [...new Set(out.data.citations)].filter((n) => valid.has(n));
  if (out.data.status === "no_reliable_answer") {
    return finish({ ...base, status: "no_reliable_answer", mode: out.data.mode, confidence: out.data.confidence, as_of: null, sources: [], gate: "model_abstained", answer: out.data.answer }, t0);
  }
  if (cfg.gates.require_citations && cited.length === 0) {
    return finish({ ...base, status: "no_reliable_answer", mode: out.data.mode, confidence: 0, as_of: null, sources: [], gate: "gate2_no_valid_citations",
      answer: "No reliable answer was found in the corpus: the model's answer could not be tied to any retrieved source." }, t0);
  }
  return finish({
    ...base, status: "answered", mode: out.data.mode, answer: out.data.answer, as_of: out.data.as_of, confidence: out.data.confidence, gate: "none",
    sources: sources.filter((s) => cited.includes(s.n)),
  }, t0);
}

function finish(res: AskResult, t0: number, extra: { error?: boolean } = {}): AskResult {
  res.trace.latency_ms = Date.now() - t0;
  run("INSERT INTO questions_log (ts, question, status, mode, cost_usd, latency_ms, response) VALUES (?,?,?,?,?,?,?)",
    nowIso(), res.question, extra.error ? "error" : res.status, res.mode, res.trace.cost_usd, res.trace.latency_ms,
    JSON.stringify({ ...res, trace: { ...res.trace, candidates: undefined } }));
  return res;
}

const esc = (s: string) => (s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
