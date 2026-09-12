// The tool-using answer loop. Instead of "one retrieval → one prompt", the model is given
// six tools and decides what to call; every decision is streamed so a human can watch the
// pipeline work. The guarantees are unchanged and still live in code, not in the prompt:
//   • sources are tagged data, instruction sentences were stripped at index time
//   • citations must be source numbers a tool actually returned this run (gate 2)
//   • every number in the answer must occur in text a tool returned (gate 3, optional)
//   • no tool ever returned a source → gate 1
//   • provider failure → gate `model_error`, never a silent "I don't know"
// The loop itself is dumb on purpose: it hands the model tools, executes them, and counts.
//
// Pipeline position: crawl → dedup → index → facts → retrieve → **answer (agent)** → eval.
// Two things break loudly if this file is wrong. `applyGates` is the last check before an
// answer reaches a human — skip a gate and an invented figure ships. The events emitted along
// the way are a contract with the UI and with `questions_log.response` (docs/agentic-spec.md):
// rename an event or a stage id and the live pipeline view goes blank while the answer itself
// still looks fine.
//
// Read it in this order: the event shapers, `runToolStep` (one tool call), `applyGates` (the
// verdict), then `runAgent` at the bottom, which is only those three plus a loop.

import { getConfig } from "../config.js";
import { nowIso } from "../db.js";
import { embeddingsEnabled } from "../embeddings.js";
import { completeWithTools, loadPrompt, type Turn } from "../llm.js";
import { withStageMetrics } from "../metrics.js";
import { ask } from "./ask.js";
import { ftsQuery } from "./retrieve.js";
import {
  SourceRegistry,
  applyAnswerGates,
  logQuestion,
  refusal,
  type Answer,
  type AskResult,
  type ResultBase,
  type Step,
} from "./shared.js";
import { TOOL_DECLS, TOOL_STAGE, runTool, type ToolRun } from "./tools.js";

/** The stages the UI draws as a pipeline. These ids are part of the SSE contract. */
export type StageId = "plan" | "search" | "facts" | "live" | "read" | "answer" | "verify";
export const STAGE_ORDER: StageId[] = ["plan", "search", "facts", "live", "read", "answer", "verify"];
const STAGE_LABEL: Record<StageId, string> = {
  plan: "Planning the search",
  search: "Searching the corpus",
  facts: "Reading the fact ledger",
  live: "Checking live sources",
  read: "Reading a full document",
  answer: "Writing the answer",
  verify: "Verifying citations",
};

export type AgentEvent =
  | { event: "stage"; data: { id: StageId; label: string; status: "start" | "done" | "skip"; ms?: number; detail?: unknown } }
  | { event: "tool_call"; data: { step: number; tool: string; args: Record<string, any>; label: string } }
  | { event: "tool_result"; data: { step: number; tool: string; summary: string; ms: number; items?: Step["items"] } }
  | { event: "note"; data: { text: string } }
  | { event: "final"; data: AskResult }
  | { event: "error"; data: { message: string } };

export type Emit = (e: AgentEvent) => void;

// --- pure event shaping (unit-tested) --------------------------------------------------
// Built by functions rather than inline object literals so agent.test.ts can pin the exact
// shape the browser reads, without running a model. `ms` and `detail` are omitted rather than
// sent as undefined: they cross the wire as JSON, where an absent key and a null differ.
export const stageEvent = (id: StageId, status: "start" | "done" | "skip", ms?: number, detail?: unknown): AgentEvent => ({
  event: "stage",
  data: {
    id,
    label: STAGE_LABEL[id],
    status,
    ...(ms === undefined ? {} : { ms }),
    ...(detail === undefined ? {} : { detail }),
  },
});

/** Human label for a pending tool call — what the UI shows while the step is running. */
export function toolCallLabel(tool: string, args: Record<string, any>): string {
  switch (tool) {
    case "search_corpus": return `Searching the corpus for “${String(args.query ?? "").slice(0, 60)}”`;
    case "fact_history": return `Reading the ledger history of “${args.key}”`;
    case "get_document": return `Opening document ${args.doc_id ?? args.url}`;
    case "fetch_live_page": return `Fetching ${args.url} live`;
    case "everstake_live_data": return `Calling Everstake's MCP · ${args.tool}`;
    default: return tool;
  }
}
export const toolCallEvent = (step: number, tool: string, args: Record<string, any>): AgentEvent =>
  ({ event: "tool_call", data: { step, tool, args, label: toolCallLabel(tool, args) } });

// --- the loop --------------------------------------------------------------------------

/**
 * The opening turn. The question, today's date (the model has no clock, and every "is this
 * current" judgement needs one) and an explicit push to call a tool rather than answer.
 */
const firstUserTurn = (question: string): Turn[] => [
  { role: "user", parts: [{ text: `Question: ${question}\n\nToday is ${nowIso().slice(0, 10)}. Start by choosing a tool.` }] },
];

/**
 * Execute one tool call and emit everything the UI needs to render it.
 *
 * A thrown tool becomes an error envelope rather than an exception: a 404 from a live page or
 * an MCP outage is information the model can act on (search the corpus instead, or abstain),
 * whereas an exception here would end the run as `model_error` and blame the provider for a
 * third party's downtime.
 */
async function runToolStep(
  stepNumber: number,
  call: { name: string; args: Record<string, any> },
  reg: SourceRegistry,
  emit: Emit,
): Promise<{ step: Step; content: unknown }> {
  const stage = TOOL_STAGE[call.name] ?? "search";
  emit(stageEvent(stage, "start", undefined, { tool: call.name }));
  emit(toolCallEvent(stepNumber, call.name, call.args));

  const startedAt = Date.now();
  const result: ToolRun = await runTool(call.name, call.args, reg).catch((e: any) => ({
    content: { error: String(e?.message ?? e).slice(0, 200) },
    summary: `tool error: ${String(e?.message ?? e).slice(0, 120)}`,
  }));
  const ms = Date.now() - startedAt;

  const step: Step = { step: stepNumber, tool: call.name, args: call.args, summary: result.summary, ms, items: result.items };
  emit({ event: "tool_result", data: { step: stepNumber, tool: call.name, summary: result.summary, ms, items: result.items } });
  emit(stageEvent(stage, "done", ms, { summary: result.summary }));
  return { step, content: result.content };
}

/**
 * The gates, in the order they must run, over whatever the loop ended up with.
 *
 * The first two are the agent's own; everything after them is `applyAnswerGates` from
 * ./shared.ts — the same code `ask()` runs, which is what stops the agent from quietly being
 * more permissive than the single-shot path. Here "no evidence" means "no tool returned a
 * citable source" rather than "the retrieval scored below a floor", because the agent has no
 * single retrieval to score.
 */
function applyGates(params: {
  base: ResultBase;
  reg: SourceRegistry;
  answer: Answer | null;
  gates: { require_citations: boolean; require_grounded_numbers: boolean };
  done: (res: AskResult, detail: unknown) => AskResult;
}): AskResult {
  const { base, reg, answer, gates, done } = params;

  // gate 1: no tool ever returned a citable source, so there is nothing to be grounded in.
  if (reg.sources.length === 0) {
    return done(
      refusal(base, "gate1_no_evidence", "No reliable answer was found in the corpus for this question."),
      { gate: "gate1_no_evidence" },
    );
  }

  // The loop ran out of turns without a `finish` call. Reported as an abstention rather than an
  // error: tools did return evidence, the model simply never committed to a conclusion.
  if (!answer) {
    return done(
      refusal(base, "model_abstained", "The agent stopped without producing an answer."),
      { gate: "model_abstained" },
    );
  }

  const { result, detail } = applyAnswerGates({ base, reg, answer, gates });
  return done(result, detail);
}

/**
 * Everything one agent run accumulates. Passed around as one mutable object rather than seven
 * variables so the loop can be a separate function from `runAgent` without a seven-argument
 * signature; every field is read by `agentResultBase` when a result is built.
 */
interface RunState {
  /** One registry for the whole run: what makes [7] mean the same thing on step 2 and step 6. */
  reg: SourceRegistry;
  steps: Step[];
  /** Stages a tool actually touched, so the rest can be reported as skipped. */
  usedStages: Set<StageId>;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  /** The model actually called, filled in after the first turn. */
  model: string | null;
  /** FTS expression of the first `search_corpus` call — the UI's "the query we ran". */
  firstQuery: string;
}

/**
 * The parts of an `AskResult` that describe the run so far. Built on demand rather than once,
 * because cost, usage and the registry keep growing — a snapshot taken up front would report
 * the state before the tools ran.
 */
function agentResultBase(question: string, cfg: ReturnType<typeof getConfig>, state: RunState): ResultBase {
  return {
    question,
    steps: state.steps,
    trace: {
      engine: "agent" as const,
      fts_query: state.firstQuery,
      vector_used: embeddingsEnabled(),
      // `candidates` is empty by design: the agent has no single retrieval to show, so the UI's
      // "why this source" table is fed from the chunks the tools actually returned.
      candidates: [],
      selected: state.reg.chunks,
      facts: state.reg.factRows,
      model: state.model,
      usage: state.usage,
      cost_usd: Number(state.costUsd.toFixed(6)),
      latency_ms: 0,
      // Always 0 by construction: instruction sentences were stripped at index time, and live
      // pages are stripped again on fetch, so none can be in this context.
      instructions_in_context: 0,
      config: { ranking: cfg.ranking, retrieval: cfg.retrieval, filters: cfg.filters, gates: cfg.gates },
    },
  };
}

/**
 * The loop itself: model turn → tool call → tool result → repeat, until the model calls
 * `finish` or the turn budget runs out. Deliberately dumb — it chooses nothing, it only hands
 * the model tools, executes what it asks for and counts. Every judgement about the ANSWER
 * happens afterwards, in the gates.
 *
 * Returns the model's `finish` arguments, or null if the run ended without one. A provider
 * failure comes back as `providerError` rather than as a throw, because the caller has to turn
 * it into a `model_error` result — an outage is not an abstention.
 */
async function runToolLoop(
  question: string,
  cfg: ReturnType<typeof getConfig>,
  state: RunState,
  emit: Emit,
): Promise<{ answer: Answer | null; providerError?: string }> {
  const contents: Turn[] = firstUserTurn(question);
  let answer: Answer | null = null;
  let toolCalls = 0;
  let emptyTurns = 0;
  let fruitless = 0; // consecutive corpus searches whose top hits the run had already seen
  const seenTopHits = new Set<string>();

  emit(stageEvent("plan", "start"));
  const planStart = Date.now();

  // Each iteration is one model turn. The model must call a tool (toolConfig mode ANY), so
  // the run ends either through `finish` or through the forced-finish turn below.
  //
  // `max_steps + 2` turns for `max_steps` (6) tool calls: one spare turn for the forced
  // `finish`, and one for the "you did not call a tool" nudge below. The budget is a cost
  // ceiling — each tool result is carried into every later turn, so turn six pays for the
  // context of all five before it.
  for (let turn = 0; turn < cfg.agent.max_steps + 2; turn++) {
    const forceFinish = toolCalls >= cfg.agent.max_steps;
    let out;
    try {
      out = await completeWithTools({
        stage: "agent",
        model: cfg.models.answer,
        system: loadPrompt("agent"),
        contents,
        tools: TOOL_DECLS,
        // Restricting the callable set to `finish` is what makes the budget a real limit: asking
        // the model to stop is a request, removing the other tools is a guarantee.
        allowedFunctionNames: forceFinish ? ["finish"] : undefined,
        maxTokens: 2500,
        meta: { question, turn },
      });
    } catch (e: any) {
      return { answer: null, providerError: String(e?.message ?? e).slice(0, 300) };
    }

    // Accumulated across turns, not per turn: a six-call run is billed as one question, and
    // `agentResultBase` reads these on every result it builds.
    state.costUsd += out.costUsd;
    state.model = out.model;
    state.usage.input += out.usage.input;
    state.usage.output += out.usage.output;
    state.usage.cacheRead += out.usage.cacheRead;
    state.usage.cacheWrite += out.usage.cacheWrite;

    if (turn === 0) {
      emit(stageEvent("plan", "done", Date.now() - planStart, { tools_available: TOOL_DECLS.length, max_steps: cfg.agent.max_steps }));
    }
    // The model's own reasoning text, streamed for the human watching. It is never parsed and
    // never becomes evidence — only tool results reach the registry.
    if (out.data.text) emit({ event: "note", data: { text: out.data.text.slice(0, 600) } });

    const call = out.data.calls[0];
    if (!call) {
      // mode ANY makes this rare; nudge once, then let the forced-finish turn handle it.
      if (++emptyTurns > 1) break;
      contents.push({ role: "user", parts: [{ text: "You did not call a tool. Call one now, or call finish." }] });
      continue;
    }
    // The model's turn is appended before the tool runs, so the transcript stays in the order
    // the provider requires: model call, then its functionResponse.
    contents.push({ role: "model", parts: out.data.parts });

    if (call.name === "finish") { answer = normaliseFinish(call.args); break; }

    toolCalls++;
    state.usedStages.add(TOOL_STAGE[call.name] ?? "search");
    // The first search's FTS expression stands in for `trace.fts_query`, which the single-shot
    // path always has — it is what the UI shows as "the query we actually ran".
    if (call.name === "search_corpus" && !state.firstQuery) {
      state.firstQuery = ftsQuery(String(call.args.query ?? ""));
    }

    const { step, content } = await runToolStep(toolCalls, call, state.reg, emit);
    state.steps.push(step);
    contents.push({ role: "user", parts: [{ functionResponse: { name: call.name, response: content as object } }] });

    // Diminishing returns (typical for unanswerable questions, where the model keeps rephrasing
    // the same search): two consecutive searches that only return pages already seen end the run
    // early. Cheaper than spending the whole budget, and the answer cannot improve on evidence
    // that is not there. Other tools neither count nor reset the counter.
    if (call.name === "search_corpus") {
      // Progress means the search surfaced a top hit this run has not seen; rephrasing the same
      // query and getting the same first three pages back is not progress.
      const top = (step.items ?? []).slice(0, 3).map((i) => String((i as any).url ?? (i as any).title ?? ""));
      const novel = top.filter((u) => u && !seenTopHits.has(u)).length >= 2; // one new page among three is noise, not progress
      top.forEach((u) => u && seenTopHits.add(u));
      fruitless = novel ? 0 : fruitless + 1;
    }
    const fruitlessStop = cfg.agent.stop_after_fruitless_calls > 0 && fruitless >= cfg.agent.stop_after_fruitless_calls;
    if (fruitlessStop && toolCalls < cfg.agent.max_steps) {
      emit({ event: "note", data: { text: `The last ${fruitless} searches returned only pages already seen — asking the model to conclude with what it has.` } });
      contents.push({ role: "user", parts: [{ text: `The last ${fruitless} searches returned only pages you already saw. Call finish now with what you have, or with status "no_reliable_answer".` }] });
      toolCalls = cfg.agent.max_steps; // next turn is restricted to `finish`
      continue;
    }

    if (toolCalls >= cfg.agent.max_steps) {
      // Said in words as well as enforced by `allowedFunctionNames` next turn, so the model
      // writes its answer knowing it is the last one rather than being cut off mid-plan.
      const budgetNotice =
        `Step budget reached (${cfg.agent.max_steps} tool calls). ` +
        `Call finish now with what you have, or with status "no_reliable_answer".`;
      contents.push({ role: "user", parts: [{ text: budgetNotice }] });
    }
  }
  return { answer };
}

/**
 * Stages no tool touched are reported as "skip" rather than left blank, so the UI shows the
 * full pipeline with the unused steps greyed out instead of a shorter, different-looking one.
 * `answer` and `verify` always run, so they are never skipped.
 */
function emitSkippedStages(usedStages: Set<StageId>, emit: Emit) {
  for (const id of STAGE_ORDER) {
    if (!usedStages.has(id) && id !== "answer" && id !== "verify") emit(stageEvent(id, "skip"));
  }
}

/** Run the loop, then judge what it produced. Everything else in this file serves these two steps. */
export async function runAgent(question: string, emit: Emit = () => {}): Promise<AskResult> {
  const t0 = Date.now();
  const cfg = getConfig();
  const state: RunState = {
    reg: new SourceRegistry(),
    steps: [],
    usedStages: new Set<StageId>(["plan"]),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    model: null,
    firstQuery: "",
  };
  const base = () => agentResultBase(question, cfg, state);

  const { answer, providerError } = await runToolLoop(question, cfg, state, emit);
  if (providerError !== undefined) {
    // Provider failure is its own gate, never an abstention: an outage says nothing about
    // whether the corpus contains the answer, and the eval must not score it as a refusal.
    emit({ event: "error", data: { message: providerError } });
    return final(emit, logQuestion(
      refusal(
        base(),
        "model_error",
        `The answer model could not be reached (${providerError.slice(0, 120)}). This is an infrastructure error, not a statement about the corpus.`,
        { error: providerError },
      ),
      t0, { error: true },
    ));
  }

  emitSkippedStages(state.usedStages, emit);
  emit(stageEvent("answer", "start"));
  emit(stageEvent("answer", "done", 0, { status: answer?.status ?? "none", mode: answer?.mode ?? null }));

  // --- gates ----------------------------------------------------------------------------
  emit(stageEvent("verify", "start"));
  const tVerify = Date.now();
  const done = (res: AskResult, detail: unknown) => {
    emit(stageEvent("verify", "done", Date.now() - tVerify, detail));
    return final(emit, logQuestion(res, t0));
  };
  return applyGates({ base: base(), reg: state.reg, answer, gates: cfg.gates, done });
}

/** Gemini returns tool args as loose JSON; coerce to the same shape the single-shot path validates. */
export function normaliseFinish(args: Record<string, any>): Answer {
  // Anything that is not an ISO date is treated as no date at all. "recently" or "Q3 2026" would
  // otherwise be stored in `as_of` and rendered by the UI as if it were a real currency date.
  const asOf = typeof args.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.as_of) ? args.as_of : null;
  return {
    // Unknown values default to the strict side: "answered" only when explicitly not an
    // abstention, and the answer still has to pass every gate afterwards.
    status: args.status === "no_reliable_answer" ? "no_reliable_answer" : "answered",
    mode: args.mode === "synthesis" ? "synthesis" : "factual",
    answer: String(args.answer ?? ""),
    as_of: asOf,
    // source numbers start at 1, so anything that coerces to 0 (null, "", []) was never a citation
    citations: Array.isArray(args.citations) ? args.citations.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [],
    confidence: Math.max(0, Math.min(1, Number(args.confidence ?? 0.5))),
  };
}

/** Last event of every run, successful or not — the UI waits for it before enabling the input. */
function final(emit: Emit, res: AskResult): AskResult {
  emit({ event: "final", data: res });
  return res;
}

/**
 * Agent on Gemini, single-shot everywhere else (function calling is implemented for Gemini only).
 * The entry point every caller uses (`/ask`, `/ask/stream`, the CLI, both evals), so switching
 * provider swaps the engine without any of them knowing — and the eval records which one ran
 * in `trace.engine`.
 */
export async function answerQuestion(question: string, emit?: Emit): Promise<AskResult> {
  const { env } = await import("../config.js");
  // One measured stage run per question, whichever engine answers it: this is what stamps
  // `run_id` on the question's model calls (so the receipt can be derived from the ledger
  // rather than counted twice) and what records its wall time, CPU and peak RSS in
  // `stage_runs`. It wraps `answerQuestion` rather than `runAgent` so the single-shot path is
  // measured on exactly the same terms — otherwise the two engines could not be compared.
  return withStageMetrics(
    "question",
    async (stage) => {
      stage.items(1, "questions");
      const result = env.llmProvider !== "gemini" ? await ask(question) : await runAgent(question, emit);
      stage.meta({ engine: result.trace.engine, gate: result.gate, status: result.status });
      return result;
    },
    { question },
  );
}
