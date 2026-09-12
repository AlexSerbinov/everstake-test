// The receipt for one question: every step that happened, what it used, what it cost.
//
// Pipeline position: this runs after the answer, in `logQuestion` (./shared.ts), so both answer
// paths get one — the agent loop and the single-shot fallback. It is what the UI's expandable
// "receipt" under the pipeline line renders, and what COST.md quotes as its worked example.
//
// It is DERIVED, never accumulated: the rows come from the `llm_calls` written during this
// question's stage run (`run_id`) merged with the tool steps the agent recorded. That matters,
// because a receipt kept as a running total in the agent would be a second, independent count
// of the money — and the first time the two disagreed, neither would be trustworthy. Here, if
// the receipt says $0.0043, that is literally the sum of rows in the cost ledger.
//
// Two honesty rules encoded below:
//  · A step with no model call costs $0 and says so — "code, free" — rather than being hidden.
//    Most of a question's steps are code, and a cost view that only lists model calls invites
//    the reader to think the code is where the money is not going for some subtle reason.
//  · Time is not double counted. The query embedding happens *inside* the search step, so it is
//    marked `nested` and left out of `accounted_ms`. Whatever wall time is left over after the
//    rows is reported as `unaccounted_ms` (orchestration, SQLite, JSON) instead of being
//    silently spread over the steps.

import { all } from "../db.js";
import type { Step } from "./shared.js";

/** `llm_calls` stages that represent the model thinking, as opposed to a supporting call. */
const MODEL_TURN_STAGES = new Set(["agent", "answer", "classify"]);

/** Plain-language name and engine for each tool the agent can call. */
const TOOL_DISPLAY: Record<string, { label: string; engine: ReceiptRow["engine"]; detail: string }> = {
  search_corpus: { label: "Searching the corpus — BM25 + vectors, ranked in-process", engine: "code", detail: "code, free" },
  fact_history: { label: "Reading the fact ledger", engine: "code", detail: "code, free" },
  get_document: { label: "Opening the full indexed document", engine: "code", detail: "code, free" },
  fetch_live_page: { label: "Fetching a live page from the web", engine: "network", detail: "network, free" },
  everstake_live_data: { label: "Calling Everstake's own MCP server", engine: "network", detail: "network, free" },
};

export interface ReceiptRow {
  /** 1-based position in the receipt, so a row can be referred to out loud ("step 4"). */
  n: number;
  kind: "model" | "embedding" | "tool";
  /** What happened, in words a non-engineer can read. */
  label: string;
  /** What did it — a model id, or "code, free". */
  detail: string;
  engine: "model" | "code" | "network";
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  usd: number;
  ms: number | null;
  /** This row's time is already inside another row's, so it is excluded from `accounted_ms`. */
  nested: boolean;
  /** The call failed; it still cost latency and is still listed. */
  failed?: boolean;
}

export interface Receipt {
  /** The `stage_runs.run_id` these rows were attributed by, or null for an unmeasured question. */
  run_id: string | null;
  rows: ReceiptRow[];
  total: {
    tokens_in: number;
    tokens_out: number;
    cache_read: number;
    usd: number;
    /** Sum of the non-nested rows' durations. */
    accounted_ms: number;
    /** End-to-end wall time of the question, as measured by the answer path. */
    wall_ms: number;
    /** wall − accounted: orchestration, SQLite writes, JSON. Never negative. */
    unaccounted_ms: number;
    model_calls: number;
    tool_calls: number;
  };
}

interface LlmCallRow {
  id: number;
  stage: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  ok: number;
}

/**
 * Build the receipt for one question.
 *
 * @param runId the `stage_runs.run_id` of this question. Null when the question was answered
 *   outside a measured stage (a direct `runAgent` call in a test): the receipt then contains the
 *   tool steps alone, with no model rows, and says so by having `run_id: null` — better than
 *   attributing whichever `llm_calls` rows happen to be newest.
 * @param steps the agent's recorded tool calls, in order. Empty for the single-shot path.
 * @param wallMs end-to-end latency of the question.
 */
export function buildReceipt(runId: string | null, steps: Step[], wallMs: number): Receipt {
  const calls = runId
    ? all<LlmCallRow>(
        `SELECT id, stage, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, ok
         FROM llm_calls WHERE run_id = ? ORDER BY id`, runId)
    : [];

  const rows = mergeCallsAndSteps(calls, steps);
  rows.forEach((row, index) => { row.n = index + 1; });
  return { run_id: runId, rows, total: totalise(rows, wallMs) };
}

/**
 * Interleave the model calls with the tool steps in the order they actually happened.
 *
 * The agent loop alternates strictly — model turn 1 asks for a tool, tool 1 runs, model turn 2
 * sees its result — so the merge needs no timestamps: tool step *k* sits between model turn *k*
 * and model turn *k+1*. Supporting calls made inside a step (the query embedding) are logged
 * between those two model rows and are emitted where they land, just before the step that
 * contains them, marked `nested`.
 *
 * Any tool steps left after the last model row are flushed at the end. That happens on the
 * forced-finish turn, and on the single-shot path, where there are no model turns to interleave.
 */
function mergeCallsAndSteps(calls: LlmCallRow[], steps: Step[]): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  let stepIndex = 0;
  let modelTurn = 0;

  for (const call of calls) {
    if (!MODEL_TURN_STAGES.has(call.stage)) {
      rows.push(supportingCallRow(call));
      continue;
    }
    // A new model turn means the previous turn's tool has already run; emit it first.
    if (modelTurn > 0 && stepIndex < steps.length) rows.push(toolRow(steps[stepIndex++]));
    rows.push(modelRow(call, ++modelTurn, modelTurn === countModelTurns(calls)));
  }
  while (stepIndex < steps.length) rows.push(toolRow(steps[stepIndex++]));
  return rows;
}

const countModelTurns = (calls: LlmCallRow[]) =>
  calls.filter((call) => MODEL_TURN_STAGES.has(call.stage)).length;

/** One model turn. The last one is named for what it does — writing the answer. */
function modelRow(call: LlmCallRow, turn: number, isLast: boolean): ReceiptRow {
  // Spaces rather than commas between thousands, matching COST.md and the UI tables: the same
  // number must not be spelled two ways in two places a reader compares side by side.
  const cached = call.cache_read_tokens
    ? ` (${call.cache_read_tokens.toLocaleString("en-US").replace(/,/g, " ")} of them already cached)` : "";
  const what = isLast ? "writing the answer" : "deciding what to look at next";
  return {
    n: 0,
    kind: "model",
    label: `Model turn ${turn} — ${what}${cached}`,
    detail: call.model,
    engine: "model",
    model: call.model,
    tokens_in: call.input_tokens,
    tokens_out: call.output_tokens,
    cache_read: call.cache_read_tokens,
    usd: call.cost_usd,
    ms: call.latency_ms,
    nested: false,
    ...(call.ok ? {} : { failed: true }),
  };
}

/**
 * A model call that is not a turn of the conversation — in practice the query embedding, which
 * happens inside the search step. Its latency is therefore part of that step's, hence `nested`.
 */
function supportingCallRow(call: LlmCallRow): ReceiptRow {
  return {
    n: 0,
    kind: "embedding",
    label: "Turning the question into a vector, to search by meaning as well as by keyword",
    detail: call.model,
    engine: "model",
    model: call.model,
    tokens_in: call.input_tokens,
    tokens_out: call.output_tokens,
    cache_read: call.cache_read_tokens,
    usd: call.cost_usd,
    ms: call.latency_ms,
    nested: true,
    ...(call.ok ? {} : { failed: true }),
  };
}

/** How much of a tool's own summary fits on a receipt line before it stops being a line. */
const TOOL_SUMMARY_CHARS = 90;

/** One tool call. No model is involved, so the cost is a measured zero, not an unknown. */
function toolRow(step: Step): ReceiptRow {
  const display = TOOL_DISPLAY[step.tool]
    ?? { label: step.tool, engine: "code" as const, detail: "code, free" };
  // The summary is the tool's own words and can run to a paragraph (an MCP payload, say).
  // Trimmed here rather than in the UI so the receipt reads the same in COST.md and on screen.
  const summary = step.summary.length > TOOL_SUMMARY_CHARS
    ? step.summary.slice(0, TOOL_SUMMARY_CHARS).trimEnd() + "…"
    : step.summary;
  return {
    n: 0,
    kind: "tool",
    label: `${display.label} — ${summary}`,
    detail: display.detail,
    engine: display.engine,
    model: null,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    usd: 0,
    ms: step.ms,
    nested: false,
    ...(step.error ? { failed: true } : {}),
  };
}

/** The footer line. Money and tokens are exact sums of the rows; time is explained, not forced. */
function totalise(rows: ReceiptRow[], wallMs: number): Receipt["total"] {
  const sum = (pick: (row: ReceiptRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const accountedMs = rows
    .filter((row) => !row.nested)
    .reduce((total, row) => total + (row.ms ?? 0), 0);
  return {
    tokens_in: sum((row) => row.tokens_in),
    tokens_out: sum((row) => row.tokens_out),
    cache_read: sum((row) => row.cache_read),
    // Rounded to a tenth of a millionth of a dollar: enough to keep a $0.000001 embedding
    // visible, few enough digits that float addition noise never shows up in the report.
    usd: Number(sum((row) => row.usd).toFixed(7)),
    accounted_ms: accountedMs,
    wall_ms: wallMs,
    // Clamped at zero: rounding in the provider's own latency figures can push the sum a
    // millisecond past the wall clock, and a negative "unaccounted" would read as a bug.
    unaccounted_ms: Math.max(0, wallMs - accountedMs),
    model_calls: rows.filter((row) => row.engine === "model").length,
    tool_calls: rows.filter((row) => row.kind === "tool").length,
  };
}
