// The single-shot path: one retrieval → one prompt → one answer. Still the fallback for
// the agent (src/ask/agent.ts) and the only path on non-Gemini providers.
// Four checks protect "I don't know", in this order:
//   gate 1 (before the model): nothing relevant retrieved → no_reliable_answer, zero LLM cost
//   model_abstained          : the model itself says the sources do not support an answer
//   gate 2 (after the model) : citations must be numbers of sources actually provided
//   gate 3 (after the model) : every numeral must occur in the text we handed the model
// A provider outage is its own gate (`model_error`), never one of the above.
// Context is passed as tagged data (<source id=…>), never as instructions (assignment §5.4).
//
// Pipeline position: crawl → dedup → index → facts → retrieve → **answer** → eval.
// Gate 1 is local to this path (the agent has no single retrieval to score); everything after
// the model call is `applyAnswerGates` from ./shared.ts, run identically by `runAgent()`. That
// sharing is the point: the agent cannot quietly relax a rule this path enforces.

import { getConfig } from "../config.js";
import { nowIso } from "../db.js";
import { completeJson, loadPrompt } from "../llm.js";
import { retrieve, type Retrieval } from "./retrieve.js";
import {
  AnswerSchema,
  SourceRegistry,
  applyAnswerGates,
  logQuestion,
  refusal,
  type AskResult,
  type ResultBase,
} from "./shared.js";

export type { AskResult, Source } from "./shared.js";

/**
 * Gate 1, before any model call: is there anything worth asking about?
 *
 * Two ways to fail — nothing retrieved at all, or a best score under `gates.min_best_score`
 * (0.012, hand-tuned against the eval set; no measurement fixes that exact value) with no fact
 * rows either. The fact-row escape hatch matters: the ledger is looked up by key, so "who is
 * the CEO" can be perfectly answerable on a question whose wording matches no chunk.
 *
 * Refusing here rather than after the model is not only about cost ($0 instead of ~$0.01): a
 * model given weak context tends to produce a fluent answer from its own knowledge, and gates 2
 * and 3 cannot catch a claim that is unsourced but carries no number and cites a real page.
 */
function hasNothingWorthAsking(retrieval: Retrieval, minBestScore: number): boolean {
  const best = retrieval.selected[0]?.score ?? 0;
  return retrieval.selected.length === 0 || (best < minBestScore && retrieval.facts.length === 0);
}

/**
 * The user turn: the question, the numbered sources, the fact ledger, today's date.
 *
 * Sources go in as `<source id=…>` blocks and facts as `<fact …>` rows — tagged data, so a
 * sentence inside a page that addresses "AI assistants" is visibly a quotation rather than part
 * of the prompt. Instruction sentences were already removed at index time; the tagging is the
 * second line of defence (assignment §5.4).
 *
 * Today's date is supplied because the model has no clock, and every "is this still current"
 * judgement — including the `live_page_as_of` rule — depends on knowing it.
 */
function buildAnswerPrompt(question: string, sourceBlocks: string[], factBlocks: string[]): string {
  const ledger = factBlocks.length
    ? `<fact_ledger note="structured facts extracted earlier from the same corpus; newest first">\n${factBlocks.join("\n")}\n</fact_ledger>`
    : `<fact_ledger/>`;
  return [
    `Question: ${question}`,
    ``,
    `<sources>`, ...sourceBlocks, `</sources>`,
    ``,
    ledger,
    ``,
    `Today is ${nowIso().slice(0, 10)}. Answer as JSON.`,
  ].join("\n");
}

/**
 * Answer one question in a single model call, or refuse. Every outcome — answered or refused —
 * is written to `questions_log`, so the eval and the UI replay the same row rather than
 * re-running the question.
 */
export async function ask(question: string): Promise<AskResult> {
  const t0 = Date.now();
  const cfg = getConfig();
  const retrieval = await retrieve(question);
  const base: ResultBase = {
    question,
    trace: {
      engine: "single-shot",
      fts_query: retrieval.fts_query,
      vector_used: retrieval.vector_used,
      candidates: retrieval.candidates,
      selected: retrieval.selected,
      facts: retrieval.facts,
      model: null, usage: null, cost_usd: 0, latency_ms: 0,
      // Always 0 by construction, not by measurement: instruction sentences were removed from
      // the chunks at index time, so none can be in this context. Reported so the claim is
      // visible in the trace rather than only in the write-up.
      instructions_in_context: 0,
      // A copy of the knobs this answer was produced under, so a stored answer can be explained
      // later even after someone changes the config live via PUT /api/config.
      config: { ranking: cfg.ranking, retrieval: cfg.retrieval, filters: cfg.filters, gates: cfg.gates },
    },
  };

  // --- gate 1: is there anything worth asking the model about? ------------------
  if (hasNothingWorthAsking(retrieval, cfg.gates.min_best_score)) {
    return logQuestion(
      refusal(base, "gate1_no_evidence", "No reliable answer was found in the corpus for this question."),
      t0,
    );
  }

  // --- build context: numbered sources, facts as rows ---------------------------
  // One registry per question: it mints the [n] numbers and, just as importantly, collects the
  // verbatim text behind them in `reg.evidence`, which is what gate 3 checks the answer against.
  const reg = new SourceRegistry();
  const blocks = reg.addChunks(retrieval.selected).map((entry) => entry.block);
  const factBlocks = reg.addFacts(retrieval.facts).map((entry) => entry.block);
  const user = buildAnswerPrompt(question, blocks, factBlocks);

  let out;
  try {
    out = await completeJson({
      stage: "answer",
      model: cfg.models.answer,
      effort: cfg.models.effort,
      system: loadPrompt("answer"),
      user,
      schema: AnswerSchema,
      maxTokens: 2500,
      // The system prompt is identical on every question, so caching it is the one free saving
      // on this path — the user turn (sources) changes every time and cannot be cached.
      cacheSystem: true,
      meta: { question },
    });
  } catch (e: any) {
    // provider failure is NOT an abstention — it is reported as its own gate so eval and UI never mistake it for "I don't know"
    const message = String(e?.message ?? e).slice(0, 300);
    return logQuestion(
      refusal(
        base,
        "model_error",
        `The answer model could not be reached (${message.slice(0, 120)}). This is an infrastructure error, not a statement about the corpus.`,
        { error: message },
      ),
      t0,
      { error: true },
    );
  }
  // `out.model` is the model actually called after provider resolution, not the alias from
  // kb.yaml — the report must quote what ran, not what was configured.
  base.trace.model = out.model;
  base.trace.usage = out.usage;
  base.trace.cost_usd = out.costUsd;

  // --- gates 2 and 3, plus the model's own abstention -----------------------------
  // Shared with the agent path (./shared.ts) rather than written twice, so neither engine can
  // drift into being more permissive than the other. The single-shot path has no stream, so
  // the per-gate `detail` is discarded here.
  const { result } = applyAnswerGates({ base, reg, answer: out.data, gates: cfg.gates });
  return logQuestion(result, t0);
}
