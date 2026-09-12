// The only place in the system that talks to a language model.
//   `complete()`         → plain text
//   `completeJson()`     → an object validated against a zod schema
//   `completeWithTools()`→ one turn of the tool-using agent loop
//
// Why exactly one module. Two reasons, and the second is the graded one:
//  1. Provider choice becomes a one-line `.env` switch instead of a refactor — the answer
//     path, the fact extractor, the classifier and the eval judge all come through here, so
//     none of them contains a URL, an API key or a provider quirk.
//  2. The assignment asks for *measured* cost, not an estimate (§5.6). Every call — success
//     or failure — writes a row to `llm_calls` with the provider's own token counts, the
//     latency and the USD it cost. `npm run cost` sums that table and nothing else, so the
//     figures in REPORT.md §3 cannot drift from what actually happened. A model call that
//     bypassed this module would be spend the report does not know about, which is why
//     `src/embeddings.ts` also calls `logCall()`/`priceUsd()` from here rather than its own.
//
// Three providers sit behind the same functions:
//   anthropic  — the official SDK. Structured output via `output_config` + zodOutputFormat,
//                and prompt caching on the system prompt. The reference implementation.
//   openrouter — the same Claude models over an OpenAI-shaped API, for machines with no
//                Anthropic account. Model ids are translated by OPENROUTER_MODEL below.
//   gemini     — plain REST. The provider the submitted EVAL.md run used (REPORT.md §2.8).
//
// What breaks if this is wrong: a bad price entry produces costs that are self-consistent and
// false; a missing `logCall` produces invisible spend; and a provider branch that returns
// usage in the wrong bucket (cache-read counted as input, say) inflates the bill by ~10×.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { ROOT, env, getConfig } from "./config.js";
import { nowIso, run } from "./db.js";
import { currentRunId } from "./metrics.js";

/** Which pipeline step a call belongs to. It is the grouping key of the cost report, and the
 *  reason `npm run cost` can say "indexing cost this much, answering costs this much per
 *  question": index = embed + facts, per-query = answer + agent, eval = judge. */
export type Stage = "facts" | "answer" | "agent" | "judge" | "classify" | "embed" | "other";

export interface LlmResult<T = string> {
  data: T;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  latencyMs: number;
  /** The model actually called, after `resolveModel` — not the alias from `kb.yaml`. */
  model: string;
  provider: string;
  /** `llm_calls.id` of the row this call wrote, so an answer can point at its own cost row. */
  callId: number;
}

/** Canonical Anthropic id → OpenRouter slug. OpenRouter namespaces by vendor and writes
 *  versions with dots where Anthropic uses dashes, so the two spellings cannot be derived
 *  from one another — hence a table. An id that is missing here is passed through unchanged,
 *  which is what lets a non-Claude OpenRouter model be configured without touching this file. */
const OPENROUTER_MODEL: Record<string, string> = {
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
};

/** Default output cap for a single-shot completion. Generous: the answer prompt asks for a
 *  short answer, and truncation would look like a model failure rather than a cap. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

/** Default output cap inside the agent loop, where each turn is one tool call plus a note. */
const DEFAULT_TOOL_MAX_OUTPUT_TOKENS = 3000;

/**
 * Extra output budget granted to thinking-capable Gemini models. On thinking-capable Gemini models the thinking
 * tokens are charged against `maxOutputTokens`, so a cap sized for the visible answer alone
 * makes the model stop mid-thought and return an empty candidate. Hand-tuned: 4000 was enough
 * for every question in the eval set; no measurement backs the exact value.
 */
const GEMINI_THINKING_HEADROOM_TOKENS = 4000;

/** Low but not zero. The answers must be reproducible enough to grade, while 0 makes models
 *  more prone to looping on a phrase. Applies to Gemini only; Anthropic uses its default. */
const GEMINI_TEMPERATURE = 0.2;

/** Provider error bodies can be an HTML page. Keep enough to identify the failure, not enough
 *  to bury the stack trace in the log. */
const ERROR_BODY_CHARS = 300;

let anthropic: Anthropic | null = null;

/** Prompts live in `prompts/*.md` as plain files, not string literals: they are the part of
 *  the system most often edited during the defence, and a file can be diffed and reviewed. */
export function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(ROOT, "prompts", `${name}.md`), "utf8");
}

/**
 * USD for one call, from `pricing_usd_per_mtok` in `config/kb.yaml`.
 *
 * Four buckets, priced separately because providers bill them separately, and by very
 * different amounts: a cache READ is ~10× cheaper than fresh input (it is already resident on
 * the provider's side), while a cache WRITE is ~1.25× the input price (it costs extra to
 * store). Collapsing them into one "input" number — the usual shortcut — would overstate a
 * cached run by roughly an order of magnitude and understate the first, uncached one.
 *
 * An unknown model costs 0 rather than throwing. That is deliberate: a missing price must not
 * take down a working answer path, and a $0 row in `llm_calls` is visible in the cost report
 * as an obviously-wrong zero. A model with no cache pricing likewise charges 0 for cache
 * tokens instead of NaN — one NaN would poison `SUM(cost_usd)` for the entire stage and
 * silently blank the report (pinned in `llm.test.ts`).
 */
export function priceUsd(
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
) {
  const prices = getConfig().pricing_usd_per_mtok[model];
  if (!prices) return 0;
  const perMillionTokens =
    usage.input * prices.input +
    usage.output * prices.output +
    (usage.cacheRead ?? 0) * (prices.cache_read ?? 0) +
    (usage.cacheWrite ?? 0) * (prices.cache_write ?? 0);
  return perMillionTokens / 1e6;
}

/**
 * Append one row to the cost ledger and return its id.
 *
 * Called on every provider call, including the ones that threw: a stage that fails half the
 * time has to be visible in the report (`ok=0`), not merely missing from it. Writes are
 * synchronous and unbatched — at a few hundred calls per index build that is free, and it
 * guarantees the row exists even if the process dies on the next line.
 */
export function logCall(call: {
  stage: Stage; provider: string; model: string;
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  costUsd?: number; latencyMs?: number; ok?: boolean; error?: string; meta?: unknown;
}): number {
  const inserted = run(
    `INSERT INTO llm_calls (ts, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, ok, error, meta, run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nowIso(), call.stage, call.provider, call.model, call.input ?? 0, call.output ?? 0, call.cacheRead ?? 0, call.cacheWrite ?? 0,
    // `ok === false` rather than `!call.ok`: an omitted flag means success, which is the
    // common case and must not be recorded as an error.
    call.costUsd ?? 0, call.latencyMs ?? null, call.ok === false ? 0 : 1, call.error ?? null, call.meta ? JSON.stringify(call.meta) : null,
    // Which stage run paid for this call. NULL when the call happened outside any wrapped stage
    // (a bare script, or a row written before stage_runs existed) — the cost report treats a
    // NULL as "attributable by stage tag only, with no time or CPU recovered".
    currentRunId(),
  );
  return Number(inserted.lastInsertRowid);
}

/** Ledger row for a call that came back. Shared by the single-shot and the tool paths so the
 *  two cannot drift into logging different fields. */
function logUsage(args: {
  stage: Stage;
  model: string;
  usage: LlmResult["usage"];
  costUsd: number;
  latencyMs: number;
  meta?: unknown;
}): number {
  return logCall({
    stage: args.stage,
    provider: env.llmProvider,
    model: args.model,
    ...args.usage,
    costUsd: args.costUsd,
    latencyMs: args.latencyMs,
    meta: args.meta,
  });
}

/** Ledger row for a call that threw. No usage is known — the provider either never answered
 *  or answered with an error — so only the latency and the message are recorded. */
function logFailure(args: { stage: Stage; model: string; startedAt: number; error: any; meta?: unknown }) {
  logCall({
    stage: args.stage,
    provider: env.llmProvider,
    model: args.model,
    latencyMs: Date.now() - args.startedAt,
    ok: false,
    error: String(args.error?.message ?? args.error),
    meta: args.meta,
  });
}

interface CallOpts {
  stage: Stage;
  model: string;               // canonical Anthropic id, e.g. claude-opus-5
  system: string;
  user: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  cacheSystem?: boolean;       // put a cache breakpoint after the system prompt
  /** Free-form context stored as JSON in `llm_calls.meta` — question id, document id, etc.
   *  It is what makes an unexpected cost row traceable back to what triggered it. */
  meta?: unknown;
}

/** Plain-text completion. */
export async function complete(opts: CallOpts): Promise<LlmResult<string>> {
  return call(opts, null) as Promise<LlmResult<string>>;
}

/**
 * Completion parsed into `schema`.
 *
 * The schema is enforced twice on purpose. Anthropic gets it as a native structured-output
 * format; Gemini and OpenRouter get the JSON Schema appended to the system prompt plus a
 * JSON response mode. Either way the returned JSON is re-validated with zod here before it
 * is handed back, because "the provider said it would return this shape" is a promise, not a
 * guarantee — models emit a fenced code block, a trailing sentence, a missing enum member or
 * a number as a string often enough to matter. A validation failure throws, which surfaces as
 * a logged error and an abstention, instead of a half-populated object flowing into the
 * fact ledger where it would look like evidence.
 */
export async function completeJson<T>(opts: CallOpts & { schema: z.ZodType<T> }): Promise<LlmResult<T>> {
  return call(opts, opts.schema) as Promise<LlmResult<T>>;
}

/**
 * Config alias → the model id actually sent to the provider.
 *
 * This is the thing that confuses readers of EVAL.md, so plainly: `config/kb.yaml` always
 * names Claude models (`models.answer: claude-opus-5`), even when the run is on Gemini. The
 * config key is an *authority level*, not a vendor choice — "the good model" and "the cheap
 * model". On `LLM_PROVIDER=gemini` this function maps by family: anything `claude-haiku-*`
 * becomes `GEMINI_CHEAP_MODEL`, everything else becomes `GEMINI_ANSWER_MODEL`. An explicit
 * `gemini-*` id in the config is never remapped.
 *
 * So an eval row saying `claude-opus-5` in the config and `gemini-3.8-flash` in `llm_calls`
 * is not a bug: the ledger records the resolved model, which is the one that was billed.
 * Anthropic and OpenRouter pass the name through unchanged here — the OpenRouter slug is
 * applied later, at call time, by `OPENROUTER_MODEL`.
 */
export function resolveModel(model: string): string {
  if (env.llmProvider !== "gemini") return model;
  if (model.startsWith("gemini")) return model;
  return model.startsWith("claude-haiku") ? env.geminiCheapModel : env.geminiAnswerModel;
}

/**
 * The one path every single-shot completion takes: resolve the model, dispatch to a provider,
 * time it, price it, log it. The provider branches below return only `{ data, usage }`; cost
 * accounting is centralised here so no branch can forget it.
 */
async function call<T>(opts: CallOpts, schema: z.ZodType<T> | null): Promise<LlmResult<any>> {
  const startedAt = Date.now();
  const model = resolveModel(opts.model);
  try {
    const response = await dispatchToProvider(opts, model, schema);
    const latencyMs = Date.now() - startedAt;
    const costUsd = priceUsd(model, response.usage);
    const callId = logUsage({ stage: opts.stage, model, usage: response.usage, costUsd, latencyMs, meta: opts.meta });
    return {
      data: response.data,
      usage: response.usage,
      costUsd,
      latencyMs,
      model,
      provider: env.llmProvider,
      callId,
    };
  } catch (error: any) {
    // Log the failure before rethrowing: a timed-out or refused call still consumed latency
    // and often tokens, and an error rate per stage is exactly what the cost report shows.
    logFailure({ stage: opts.stage, model, startedAt, error, meta: opts.meta });
    throw error;
  }
}

/**
 * Pick the provider implementation. Note that Gemini receives the *resolved* model while the
 * other two receive `opts.model` untouched — `resolveModel` is the identity for them, and
 * OpenRouter does its own translation, so passing the raw id keeps the `claude-haiku` prefix
 * checks in those branches working on the canonical name.
 */
async function dispatchToProvider<T>(opts: CallOpts, model: string, schema: z.ZodType<T> | null) {
  if (env.llmProvider === "anthropic") return viaAnthropic(opts, schema);
  if (env.llmProvider === "gemini") return viaGemini({ ...opts, model }, schema);
  return viaOpenRouter(opts, schema);
}

// --- function calling (the agent loop) -----------------------------------------------
// Only Gemini implements it here: the agent is a Gemini feature of this build
// (LLM_PROVIDER=gemini). Anthropic/OpenRouter keep the single-shot `ask()` path.

/** A Gemini `FunctionDeclaration`: name + description + OpenAPI-subset parameter schema. */
export interface ToolDecl { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { name: string; args: Record<string, any> }
/** One turn of the conversation in Gemini's wire format; the agent owns the array. */
export interface Turn { role: "user" | "model"; parts: any[] }

export interface ToolTurnResult {
  text: string;        // any prose the model emitted alongside the call (surfaced as a `note`)
  calls: ToolCall[];   // function calls requested this turn
  parts: any[];        // raw parts, to be appended back as the `model` turn
}

interface ToolTurnOpts {
  stage: Stage;
  model: string;
  system: string;
  contents: Turn[];
  tools: ToolDecl[];
  allowedFunctionNames?: string[];   // narrow the choice (used to force `finish` on the last step)
  maxTokens?: number;
  meta?: unknown;
}

/**
 * One turn of the tool-using agent: send the conversation so far, get back the tool calls the
 * model wants to make. The loop itself, the tool implementations and the step budget live in
 * `src/ask/agent.ts`; this function only owns the wire format and the cost row.
 */
export async function completeWithTools(opts: ToolTurnOpts): Promise<LlmResult<ToolTurnResult>> {
  if (env.llmProvider !== "gemini") {
    throw new Error(`completeWithTools requires LLM_PROVIDER=gemini (got ${env.llmProvider})`);
  }
  const model = resolveModel(opts.model);
  const startedAt = Date.now();
  try {
    const body = await fetchGemini(model, buildToolTurnBody(opts));
    const data = parseToolTurn(body);
    const usage = geminiUsage(body);
    const latencyMs = Date.now() - startedAt;
    const costUsd = priceUsd(model, usage);
    const callId = logUsage({ stage: opts.stage, model, usage, costUsd, latencyMs, meta: opts.meta });
    return { data, usage, costUsd, latencyMs, model, provider: env.llmProvider, callId };
  } catch (error: any) {
    logFailure({ stage: opts.stage, model, startedAt, error, meta: opts.meta });
    throw error;
  }
}

function buildToolTurnBody(opts: ToolTurnOpts) {
  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.contents,
    tools: [{ functionDeclarations: opts.tools }],
    // ANY = the model must call one of the tools. `finish` is itself a tool, so the loop
    // always ends through the validated path and never through free-form prose.
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY",
        ...(opts.allowedFunctionNames ? { allowedFunctionNames: opts.allowedFunctionNames } : {}),
      },
    },
    generationConfig: {
      maxOutputTokens: (opts.maxTokens ?? DEFAULT_TOOL_MAX_OUTPUT_TOKENS) + GEMINI_THINKING_HEADROOM_TOKENS,
      temperature: GEMINI_TEMPERATURE,
    },
  };
}

/** Split one Gemini candidate into the three things the agent loop needs: the prose, the
 *  requested calls, and the untouched parts to append back as the `model` turn. */
function parseToolTurn(body: any): ToolTurnResult {
  const candidate = body.candidates?.[0];
  if (!candidate) throw new Error(`gemini: no candidate (${body.promptFeedback?.blockReason ?? "empty"})`);
  const parts: any[] = candidate.content?.parts ?? [];
  return {
    // `!part.thought` drops the model's internal reasoning parts: they are billed and
    // returned, but showing them as the assistant's note would leak scratch work into the UI.
    text: parts.filter((part) => !part.thought && part.text).map((part) => part.text).join("").trim(),
    calls: parts
      .filter((part) => part.functionCall)
      .map((part) => ({ name: part.functionCall.name, args: part.functionCall.args ?? {} })),
    parts,
  };
}

// --- provider implementations ---------------------------------------------------------
// Each returns `{ data, usage }` and nothing else; timing, pricing and logging belong to the
// callers above, so a new provider cannot accidentally omit them.

async function viaGemini<T>(opts: CallOpts, schema: z.ZodType<T> | null) {
  // "lite" models: thinking stays off unless a thinkingConfig is sent (Gemini 3.x rejects thinkingBudget),
  // so they need neither the headroom nor an explicit opt-out.
  const isLiteModel = opts.model.includes("lite");
  const body: any = {
    systemInstruction: { parts: [{ text: opts.system + jsonSchemaInstruction(schema) }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: {
      maxOutputTokens: (opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + (isLiteModel ? 0 : GEMINI_THINKING_HEADROOM_TOKENS),
      temperature: GEMINI_TEMPERATURE,
      ...(schema ? { responseMimeType: "application/json" } : {}),
    },
  };
  const response = await fetchGemini(opts.model, body);
  const candidate = response.candidates?.[0];
  // SAFETY is called out separately from "empty" because it is the one failure a retry will
  // never fix — the corpus contains crypto-price pages that occasionally trip the filter.
  if (!candidate || candidate.finishReason === "SAFETY") {
    throw new Error(`gemini: no candidate (${candidate?.finishReason ?? "empty"})`);
  }
  const text: string = (candidate.content?.parts ?? [])
    .filter((part: any) => !part.thought)
    .map((part: any) => part.text ?? "")
    .join("");
  const usage = geminiUsage(response);
  if (!schema) return { data: text, usage };
  return { data: validateAgainstSchema(schema, text), usage };
}

/** POST to the Gemini REST endpoint and return the parsed body, or throw with the status. */
async function fetchGemini(model: string, body: unknown) {
  // The key travels in the query string — that is what this endpoint accepts. It must never
  // be interpolated into a log line or an error message for the same reason.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.geminiKey}`;
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, ERROR_BODY_CHARS)}`);
  return await response.json() as any;
}

/**
 * Gemini's usage block mapped onto our four buckets.
 * Thinking tokens are added to `output` because that is how they are billed — leaving them
 * out would make a reasoning model look several times cheaper than it is.
 * Gemini bills implicit cache reads but reports no write count, so `cacheWrite` is 0.
 */
function geminiUsage(body: any) {
  const usage = body.usageMetadata ?? {};
  return {
    input: usage.promptTokenCount ?? 0,
    output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheRead: usage.cachedContentTokenCount ?? 0,
    cacheWrite: 0,
  };
}

async function viaAnthropic<T>(opts: CallOpts, schema: z.ZodType<T> | null) {
  // Created on first use, not at import: constructing the client with no key would break
  // every command that never calls a model (`stats`, `cost`, the tests).
  anthropic ??= new Anthropic({ apiKey: env.anthropicKey || undefined });
  const system: Anthropic.TextBlockParam[] = [
    // A cache breakpoint here makes the system prompt (~1.5k tokens, identical on every
    // question) bill at the cache-read rate from the second call on — see REPORT.md §3.
    { type: "text", text: opts.system, ...(opts.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}) },
  ];
  const base = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user" as const, content: opts.user }],
    // Haiku has neither adaptive thinking nor an effort control, and sending them is an API
    // error — so the cheap extraction/judging path gets the bare request.
    ...(opts.model.startsWith("claude-haiku")
      ? {}
      : { thinking: { type: "adaptive" as const }, output_config: { effort: opts.effort ?? "medium" } }),
  };
  return schema ? await anthropicParsed(base, schema) : await anthropicText(base);
}

/** Structured output through the SDK's own parser: the schema is sent to the API, so the
 *  model is constrained rather than merely asked. No `extractFirstJsonObject` needed here. */
async function anthropicParsed<T>(base: any, schema: z.ZodType<T>) {
  const response = await anthropic!.messages.parse({
    ...base,
    output_config: { ...base.output_config, format: zodOutputFormat(schema) },
  });
  if (response.stop_reason === "refusal") throw new Error("model refused");
  const data = response.parsed_output;
  // Distinct from a refusal: the model answered but the output did not fit the schema.
  if (data == null) throw new Error("structured output could not be parsed");
  return { data, usage: anthropicUsage(response.usage) };
}

async function anthropicText(base: any) {
  const response = await anthropic!.messages.create(base);
  if (response.stop_reason === "refusal") throw new Error("model refused");
  // Filter to text blocks: a thinking-enabled response also carries thinking blocks, and
  // concatenating those into the answer would print the model's scratch work to the user.
  const data = response.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
  return { data, usage: anthropicUsage(response.usage) };
}

/** Anthropic reports all four buckets natively, which is why it is the reference provider for
 *  the cost model — the other two are mapped onto this shape. */
function anthropicUsage(usage: Anthropic.Usage) {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

async function viaOpenRouter<T>(opts: CallOpts, schema: z.ZodType<T> | null) {
  const model = OPENROUTER_MODEL[opts.model] ?? opts.model;
  const body: any = {
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", content: opts.system + jsonSchemaInstruction(schema) },
      { role: "user", content: opts.user },
    ],
    // `json_object` guarantees parseable JSON, not the right *shape* — the schema itself only
    // reaches the model as prose above, which is exactly why the result is re-validated.
    ...(schema ? { response_format: { type: "json_object" } } : {}),
    ...(opts.model.startsWith("claude-haiku") ? {} : { reasoning: { effort: opts.effort ?? "medium" } }),
    usage: { include: true },   // OpenRouter omits token counts unless asked; without it cost would be 0
  };
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    // Referer/X-Title are OpenRouter's attribution headers; they show up in the account's
    // usage dashboard and are how this project's spend is told apart from anything else.
    headers: {
      Authorization: `Bearer ${env.openrouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/serbinov/everstake-kb",
      "X-Title": "everstake-kb",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`openrouter ${response.status}: ${(await response.text()).slice(0, ERROR_BODY_CHARS)}`);
  const parsedBody: any = await response.json();
  const text: string = parsedBody.choices?.[0]?.message?.content ?? "";
  const reported = parsedBody.usage ?? {};
  const usage = {
    input: reported.prompt_tokens ?? 0,
    output: reported.completion_tokens ?? 0,
    cacheRead: reported.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
  };
  if (!schema) return { data: text, usage };
  return { data: validateAgainstSchema(schema, text), usage };
}

/** The schema as prose, appended to the system prompt for the two providers that cannot be
 *  handed a schema natively. Empty string when no schema, so it concatenates unconditionally. */
function jsonSchemaInstruction(schema: z.ZodType<any> | null): string {
  if (!schema) return "";
  return "\n\nRespond with a single JSON object only, matching this JSON Schema:\n" + JSON.stringify(z.toJSONSchema(schema));
}

/**
 * Parse and validate a model's JSON reply. Throws rather than returning a partial object: an
 * invalid fact row is worse than a missing one, since downstream it would be indistinguishable
 * from evidence. The zod message is truncated because it can list every failing path in a
 * large schema and would otherwise fill the log.
 */
function validateAgainstSchema<T>(schema: z.ZodType<T>, text: string): T {
  const parsed = schema.safeParse(JSON.parse(extractFirstJsonObject(text)));
  if (!parsed.success) {
    throw new Error("structured output failed validation: " + parsed.error.message.slice(0, ERROR_BODY_CHARS));
  }
  return parsed.data;
}

/**
 * Return the first balanced `{…}` object in `text`.
 *
 * Needed because "JSON mode" is a request, not a guarantee. Real replies observed from the
 * non-Anthropic providers: a ```json fenced block, a sentence of preamble before the object,
 * a trailing "Let me know if…", and occasionally a second object after the first. A plain
 * `JSON.parse` fails on all four; `text.slice(indexOf("{"), lastIndexOf("}"))` fails on the
 * last one by swallowing both objects.
 *
 * So this walks the string counting brace depth and stops at the brace that closes the first
 * object. It is string-aware — a `{`, `}` or `"` inside a JSON string literal, and a `\"`
 * escape inside it, must not move the depth counter, or `{"note":"a } b"}` would be cut short.
 *
 * Deliberately forgiving at the edges: with no `{` at all it returns the input unchanged, and
 * on an unterminated object it returns everything from the first `{`. In both cases the caller
 * is about to `JSON.parse` it and raise the real error, which carries more context than
 * anything this function could throw.
 */
export function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (isEscaped) isEscaped = false;
      else if (char === "\\") isEscaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}
