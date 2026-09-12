// The single-shot path: one retrieval → one prompt → one answer. Still the fallback for
// the agent (src/ask/agent.ts) and the only path on non-Gemini providers.
// Two gates protect "I don't know":
//   gate 1 (before the model): nothing relevant retrieved → no_reliable_answer, zero LLM cost
//   gate 2 (after the model):  answer must cite sources that were actually provided
// Context is passed as tagged data (<source id=…>), never as instructions (assignment §5.4).

import { getConfig } from "../config.js";
import { nowIso } from "../db.js";
import { completeJson, loadPrompt } from "../llm.js";
import { retrieve } from "./retrieve.js";
import { AnswerSchema, SourceRegistry, logQuestion, numericLiterals, ungroundedNumbers, validateCitations, type AskResult } from "./shared.js";

export type { AskResult, Source } from "./shared.js";

export async function ask(question: string): Promise<AskResult> {
  const t0 = Date.now();
  const cfg = getConfig();
  const r = await retrieve(question);
  const base: Omit<AskResult, "status" | "mode" | "answer" | "as_of" | "confidence" | "sources" | "gate"> = {
    question,
    trace: {
      engine: "single-shot",
      fts_query: r.fts_query, vector_used: r.vector_used, candidates: r.candidates, selected: r.selected, facts: r.facts,
      model: null, usage: null, cost_usd: 0, latency_ms: 0, instructions_in_context: 0, // by construction: instruction sentences were removed at index time
      config: { ranking: cfg.ranking, retrieval: cfg.retrieval, filters: cfg.filters, gates: cfg.gates },
    },
  };

  // --- gate 1: is there anything worth asking the model about? ------------------
  const best = r.selected[0]?.score ?? 0;
  if (r.selected.length === 0 || (best < cfg.gates.min_best_score && r.facts.length === 0)) {
    return logQuestion({ ...base, status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "gate1_no_evidence",
      answer: "No reliable answer was found in the corpus for this question." }, t0);
  }

  // --- build context: numbered sources, facts as rows ---------------------------
  const reg = new SourceRegistry();
  const blocks = reg.addChunks(r.selected).map((x) => x.block);
  const factBlocks = reg.addFacts(r.facts).map((x) => x.block);

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
    // provider failure is NOT an abstention — it is reported as its own gate so eval and UI never mistake it for "I don't know"
    return logQuestion({ ...base, status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "model_error",
      error: String(e?.message ?? e).slice(0, 300),
      answer: `The answer model could not be reached (${String(e?.message ?? e).slice(0, 120)}). This is an infrastructure error, not a statement about the corpus.` }, t0, { error: true });
  }
  base.trace.model = out.model; base.trace.usage = out.usage; base.trace.cost_usd = out.costUsd; // out.model = the model actually called (provider-resolved)

  // --- gate 2: citations must point at sources we actually provided ---------------
  const cited = validateCitations(reg, out.data.citations);
  if (out.data.status === "no_reliable_answer") {
    return logQuestion({ ...base, status: "no_reliable_answer", mode: out.data.mode, confidence: out.data.confidence, as_of: null, sources: [], gate: "model_abstained", answer: out.data.answer, evidence_numbers: [...new Set(numericLiterals(reg.evidence.join("\n")))] }, t0);
  }
  if (cfg.gates.require_citations && cited.length === 0) {
    return logQuestion({ ...base, status: "no_reliable_answer", mode: out.data.mode, confidence: 0, as_of: null, sources: [], gate: "gate2_no_valid_citations",
      answer: "No reliable answer was found in the corpus: the model's answer could not be tied to any retrieved source." }, t0);
  }
  // --- gate 3: every number in the answer must come from a source we provided ------
  const evidenceNumbers = [...new Set(numericLiterals(reg.evidence.join("\n")))];
  const ungrounded = ungroundedNumbers(out.data.answer, reg.evidence);
  if (cfg.gates.require_grounded_numbers && ungrounded.length) {
    return logQuestion({ ...base, status: "no_reliable_answer", mode: out.data.mode, confidence: 0, as_of: null, sources: [], gate: "gate3_ungrounded_number",
      ungrounded_numbers: ungrounded, evidence_numbers: evidenceNumbers,
      answer: `No reliable answer: the draft answer contained a number that appears in none of the retrieved sources, so it was not delivered.` }, t0);
  }
  return logQuestion({
    ...base, evidence_numbers: evidenceNumbers, status: "answered", mode: out.data.mode, answer: out.data.answer, as_of: out.data.as_of, confidence: out.data.confidence, gate: "none",
    sources: reg.sources.filter((s) => cited.includes(s.n)),
  }, t0);
}
