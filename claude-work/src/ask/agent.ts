// The tool-using answer loop. Instead of "one retrieval → one prompt", the model is given
// six tools and decides what to call; every decision is streamed so a human can watch the
// pipeline work. The guarantees are unchanged and still live in code, not in the prompt:
//   • sources are tagged data, instruction sentences were stripped at index time
//   • citations must be source numbers a tool actually returned this run (gate 2)
//   • every number in the answer must occur in text a tool returned (gate 3, optional)
//   • no tool ever returned a source → gate 1
//   • provider failure → gate `model_error`, never a silent "I don't know"
// The loop itself is dumb on purpose: it hands the model tools, executes them, and counts.

import { getConfig } from "../config.js";
import { nowIso } from "../db.js";
import { embeddingsEnabled } from "../embeddings.js";
import { completeWithTools, loadPrompt, type Turn } from "../llm.js";
import { ask } from "./ask.js";
import { ftsQuery } from "./retrieve.js";
import { SourceRegistry, logQuestion, numericLiterals, ungroundedNumbers, validateCitations, type Answer, type AskResult, type Step } from "./shared.js";
import { TOOL_DECLS, TOOL_STAGE, runTool, type ToolRun } from "./tools.js";

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
export const stageEvent = (id: StageId, status: "start" | "done" | "skip", ms?: number, detail?: unknown): AgentEvent =>
  ({ event: "stage", data: { id, label: STAGE_LABEL[id], status, ...(ms === undefined ? {} : { ms }), ...(detail === undefined ? {} : { detail }) } });

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

export async function runAgent(question: string, emit: Emit = () => {}): Promise<AskResult> {
  const t0 = Date.now();
  const cfg = getConfig();
  const reg = new SourceRegistry();
  const steps: Step[] = [];
  const used = new Set<StageId>(["plan"]);
  let cost = 0;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model: string | null = null;
  let firstQuery = "";

  const base = () => ({
    question,
    steps,
    trace: {
      engine: "agent" as const,
      fts_query: firstQuery, vector_used: embeddingsEnabled(),
      candidates: [], selected: reg.chunks, facts: reg.factRows,
      model, usage, cost_usd: Number(cost.toFixed(6)), latency_ms: 0, instructions_in_context: 0,
      config: { ranking: cfg.ranking, retrieval: cfg.retrieval, filters: cfg.filters, gates: cfg.gates },
    },
  });

  const contents: Turn[] = [{ role: "user", parts: [{ text: `Question: ${question}\n\nToday is ${nowIso().slice(0, 10)}. Start by choosing a tool.` }] }];
  let answer: Answer | null = null;
  let toolCalls = 0;
  let emptyTurns = 0;

  emit(stageEvent("plan", "start"));
  const planStart = Date.now();

  // Each iteration is one model turn. The model must call a tool (toolConfig mode ANY), so
  // the run ends either through `finish` or through the forced-finish turn below.
  for (let turn = 0; turn < cfg.agent.max_steps + 2; turn++) {
    const forceFinish = toolCalls >= cfg.agent.max_steps;
    let out;
    try {
      out = await completeWithTools({
        stage: "agent", model: cfg.models.answer, system: loadPrompt("agent"), contents,
        tools: TOOL_DECLS, allowedFunctionNames: forceFinish ? ["finish"] : undefined, maxTokens: 2500, meta: { question, turn },
      });
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 300);
      emit({ event: "error", data: { message } });
      return final(emit, logQuestion({
        ...base(), status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "model_error", error: message,
        answer: `The answer model could not be reached (${message.slice(0, 120)}). This is an infrastructure error, not a statement about the corpus.`,
      }, t0, { error: true }));
    }
    cost += out.costUsd; model = out.model;
    usage.input += out.usage.input; usage.output += out.usage.output; usage.cacheRead += out.usage.cacheRead; usage.cacheWrite += out.usage.cacheWrite;
    if (turn === 0) emit(stageEvent("plan", "done", Date.now() - planStart, { tools_available: TOOL_DECLS.length, max_steps: cfg.agent.max_steps }));
    if (out.data.text) emit({ event: "note", data: { text: out.data.text.slice(0, 600) } });

    const call = out.data.calls[0];
    if (!call) {
      // mode ANY makes this rare; nudge once, then let the forced-finish turn handle it.
      if (++emptyTurns > 1) break;
      contents.push({ role: "user", parts: [{ text: "You did not call a tool. Call one now, or call finish." }] });
      continue;
    }
    contents.push({ role: "model", parts: out.data.parts });

    if (call.name === "finish") { answer = normaliseFinish(call.args); break; }

    // --- run the tool ------------------------------------------------------------------
    toolCalls++;
    const stage = TOOL_STAGE[call.name] ?? "search";
    used.add(stage);
    if (call.name === "search_corpus" && !firstQuery) firstQuery = ftsQuery(String(call.args.query ?? ""));
    emit(stageEvent(stage, "start", undefined, { tool: call.name }));
    emit(toolCallEvent(toolCalls, call.name, call.args));
    const tStep = Date.now();
    const r: ToolRun = await runTool(call.name, call.args, reg)
      .catch((e: any) => ({ content: { error: String(e?.message ?? e).slice(0, 200) }, summary: `tool error: ${String(e?.message ?? e).slice(0, 120)}` }));
    const ms = Date.now() - tStep;
    const step: Step = { step: toolCalls, tool: call.name, args: call.args, summary: r.summary, ms, items: r.items };
    steps.push(step);
    emit({ event: "tool_result", data: { step: toolCalls, tool: call.name, summary: r.summary, ms, items: r.items } });
    emit(stageEvent(stage, "done", ms, { summary: r.summary }));

    contents.push({ role: "user", parts: [{ functionResponse: { name: call.name, response: r.content as object } }] });
    if (toolCalls >= cfg.agent.max_steps) {
      contents.push({ role: "user", parts: [{ text: `Step budget reached (${cfg.agent.max_steps} tool calls). Call finish now with what you have, or with status "no_reliable_answer".` }] });
    }
  }

  for (const id of STAGE_ORDER) if (!used.has(id) && id !== "answer" && id !== "verify") emit(stageEvent(id, "skip"));
  emit(stageEvent("answer", "start"));
  emit(stageEvent("answer", "done", 0, { status: answer?.status ?? "none", mode: answer?.mode ?? null }));

  // --- gates ----------------------------------------------------------------------------
  emit(stageEvent("verify", "start"));
  const tVerify = Date.now();
  const done = (res: AskResult, detail: unknown) => {
    emit(stageEvent("verify", "done", Date.now() - tVerify, detail));
    return final(emit, logQuestion(res, t0));
  };

  if (reg.sources.length === 0) {
    // gate 1: no tool ever returned a citable source, so there is nothing to be grounded in.
    return done({ ...base(), status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "gate1_no_evidence",
      answer: "No reliable answer was found in the corpus for this question." }, { gate: "gate1_no_evidence" });
  }
  if (!answer) {
    return done({ ...base(), status: "no_reliable_answer", mode: null, confidence: 0, as_of: null, sources: [], gate: "model_abstained",
      answer: "The agent stopped without producing an answer." }, { gate: "model_abstained" });
  }
  if (answer.status === "no_reliable_answer") {
    return done({ ...base(), status: "no_reliable_answer", mode: answer.mode, confidence: answer.confidence, as_of: null, sources: [], gate: "model_abstained", answer: answer.answer, evidence_numbers: [...new Set(numericLiterals(reg.evidence.join("\n")))] },
      { gate: "model_abstained" });
  }
  const cited = validateCitations(reg, answer.citations);
  if (cfg.gates.require_citations && cited.length === 0) {
    return done({ ...base(), status: "no_reliable_answer", mode: answer.mode, confidence: 0, as_of: null, sources: [], gate: "gate2_no_valid_citations",
      answer: "No reliable answer was found in the corpus: the model's answer could not be tied to any retrieved source." }, { gate: "gate2_no_valid_citations", claimed: answer.citations });
  }
  // gate 3: a number the tools never returned is an invented number, however well cited the
  // sentence around it is. Optional (gates.require_grounded_numbers) because it is the one
  // gate that can refuse an otherwise good answer.
  const evidenceNumbers = [...new Set(numericLiterals(reg.evidence.join("\n")))];
  const ungrounded = ungroundedNumbers(answer.answer, reg.evidence);
  if (cfg.gates.require_grounded_numbers && ungrounded.length) {
    return done({ ...base(), status: "no_reliable_answer", mode: answer.mode, confidence: 0, as_of: null, sources: [], gate: "gate3_ungrounded_number",
      ungrounded_numbers: ungrounded, evidence_numbers: evidenceNumbers,
      answer: `No reliable answer: the draft answer contained a number that appears in none of the retrieved sources, so it was not delivered.` },
      { gate: "gate3_ungrounded_number", ungrounded });
  }
  return done({
    ...base(), evidence_numbers: evidenceNumbers, status: "answered", mode: answer.mode, answer: answer.answer, as_of: answer.as_of, confidence: answer.confidence, gate: "none",
    sources: reg.sources.filter((s) => cited.includes(s.n)),
  }, { gate: "none", cited, dropped: answer.citations.filter((n) => !cited.includes(n)) });
}

/** Gemini returns tool args as loose JSON; coerce to the same shape the single-shot path validates. */
export function normaliseFinish(args: Record<string, any>): Answer {
  const asOf = typeof args.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.as_of) ? args.as_of : null;
  return {
    status: args.status === "no_reliable_answer" ? "no_reliable_answer" : "answered",
    mode: args.mode === "synthesis" ? "synthesis" : "factual",
    answer: String(args.answer ?? ""),
    as_of: asOf,
    // source numbers start at 1, so anything that coerces to 0 (null, "", []) was never a citation
    citations: Array.isArray(args.citations) ? args.citations.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [],
    confidence: Math.max(0, Math.min(1, Number(args.confidence ?? 0.5))),
  };
}

function final(emit: Emit, res: AskResult): AskResult {
  emit({ event: "final", data: res });
  return res;
}

/** Agent on Gemini, single-shot everywhere else (function calling is implemented for Gemini only). */
export async function answerQuestion(question: string, emit?: Emit): Promise<AskResult> {
  const { env } = await import("../config.js");
  if (env.llmProvider !== "gemini") return ask(question);
  return runAgent(question, emit);
}
