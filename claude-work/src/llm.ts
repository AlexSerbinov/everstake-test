// The only place that talks to a language model.
// - `complete()`  → plain text
// - `completeJson()` → validated object (zod schema)
// Every call is logged to `llm_calls` with tokens, latency and measured USD cost.
//
// Provider "anthropic" uses the official SDK (structured outputs via output_config).
// Provider "openrouter" reaches the same Claude models through OpenRouter's
// OpenAI-compatible endpoint — a fallback for machines without an Anthropic key.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { ROOT, env, getConfig } from "./config.js";
import { nowIso, run } from "./db.js";

export type Stage = "facts" | "answer" | "agent" | "judge" | "classify" | "embed" | "other";

export interface LlmResult<T = string> {
  data: T;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  latencyMs: number;
  model: string;
  provider: string;
  callId: number;
}

const OPENROUTER_MODEL: Record<string, string> = {
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
};

let anthropic: Anthropic | null = null;

export function loadPrompt(name: string): string {
  return fs.readFileSync(path.join(ROOT, "prompts", `${name}.md`), "utf8");
}

export function priceUsd(model: string, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) {
  const p = getConfig().pricing_usd_per_mtok[model];
  if (!p) return 0;
  return (
    (u.input * p.input + u.output * p.output + (u.cacheRead ?? 0) * (p.cache_read ?? 0) + (u.cacheWrite ?? 0) * (p.cache_write ?? 0)) / 1e6
  );
}

export function logCall(row: {
  stage: Stage; provider: string; model: string;
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
  costUsd?: number; latencyMs?: number; ok?: boolean; error?: string; meta?: unknown;
}): number {
  const r = run(
    `INSERT INTO llm_calls (ts, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, ok, error, meta)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nowIso(), row.stage, row.provider, row.model, row.input ?? 0, row.output ?? 0, row.cacheRead ?? 0, row.cacheWrite ?? 0,
    row.costUsd ?? 0, row.latencyMs ?? null, row.ok === false ? 0 : 1, row.error ?? null, row.meta ? JSON.stringify(row.meta) : null,
  );
  return Number(r.lastInsertRowid);
}

interface CallOpts {
  stage: Stage;
  model: string;               // canonical Anthropic id, e.g. claude-opus-5
  system: string;
  user: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  cacheSystem?: boolean;       // put a cache breakpoint after the system prompt
  meta?: unknown;
}

export async function complete(opts: CallOpts): Promise<LlmResult<string>> {
  return call(opts, null) as Promise<LlmResult<string>>;
}

export async function completeJson<T>(opts: CallOpts & { schema: z.ZodType<T> }): Promise<LlmResult<T>> {
  return call(opts, opts.schema) as Promise<LlmResult<T>>;
}

/** Provider "gemini": Claude model ids in config map to Gemini models (override with GEMINI_ANSWER_MODEL / GEMINI_CHEAP_MODEL). */
export function resolveModel(model: string): string {
  if (env.llmProvider !== "gemini") return model;
  if (model.startsWith("gemini")) return model;
  return model.startsWith("claude-haiku") ? env.geminiCheapModel : env.geminiAnswerModel;
}

async function call<T>(opts: CallOpts, schema: z.ZodType<T> | null): Promise<LlmResult<any>> {
  const t0 = Date.now();
  const model = resolveModel(opts.model);
  try {
    const r = env.llmProvider === "anthropic" ? await viaAnthropic(opts, schema)
      : env.llmProvider === "gemini" ? await viaGemini({ ...opts, model }, schema)
      : await viaOpenRouter(opts, schema);
    const latencyMs = Date.now() - t0;
    const costUsd = priceUsd(model, r.usage);
    const callId = logCall({ stage: opts.stage, provider: env.llmProvider, model, ...r.usage, costUsd, latencyMs, meta: opts.meta });
    return { data: r.data, usage: r.usage, costUsd, latencyMs, model, provider: env.llmProvider, callId };
  } catch (e: any) {
    logCall({ stage: opts.stage, provider: env.llmProvider, model, latencyMs: Date.now() - t0, ok: false, error: String(e?.message ?? e), meta: opts.meta });
    throw e;
  }
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

export async function completeWithTools(opts: {
  stage: Stage;
  model: string;
  system: string;
  contents: Turn[];
  tools: ToolDecl[];
  allowedFunctionNames?: string[];   // narrow the choice (used to force `finish` on the last step)
  maxTokens?: number;
  meta?: unknown;
}): Promise<LlmResult<ToolTurnResult>> {
  if (env.llmProvider !== "gemini") throw new Error(`completeWithTools requires LLM_PROVIDER=gemini (got ${env.llmProvider})`);
  const model = resolveModel(opts.model);
  const t0 = Date.now();
  try {
    const body = {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: opts.contents,
      tools: [{ functionDeclarations: opts.tools }],
      // ANY = the model must call one of the tools. `finish` is itself a tool, so the loop
      // always ends through the validated path and never through free-form prose.
      toolConfig: { functionCallingConfig: { mode: "ANY", ...(opts.allowedFunctionNames ? { allowedFunctionNames: opts.allowedFunctionNames } : {}) } },
      generationConfig: { maxOutputTokens: (opts.maxTokens ?? 3000) + 4000, temperature: 0.2 }, // +4000: thinking tokens count against the cap
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.geminiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    const cand = j.candidates?.[0];
    if (!cand) throw new Error(`gemini: no candidate (${j.promptFeedback?.blockReason ?? "empty"})`);
    const parts: any[] = cand.content?.parts ?? [];
    const data: ToolTurnResult = {
      text: parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim(),
      calls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} })),
      parts,
    };
    const u = j.usageMetadata ?? {};
    const usage = { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: u.cachedContentTokenCount ?? 0, cacheWrite: 0 };
    const latencyMs = Date.now() - t0;
    const costUsd = priceUsd(model, usage);
    const callId = logCall({ stage: opts.stage, provider: env.llmProvider, model, ...usage, costUsd, latencyMs, meta: opts.meta });
    return { data, usage, costUsd, latencyMs, model, provider: env.llmProvider, callId };
  } catch (e: any) {
    logCall({ stage: opts.stage, provider: env.llmProvider, model, latencyMs: Date.now() - t0, ok: false, error: String(e?.message ?? e), meta: opts.meta });
    throw e;
  }
}

async function viaGemini<T>(opts: CallOpts, schema: z.ZodType<T> | null) {
  const cheap = opts.model.includes("lite");
  const body: any = {
    systemInstruction: { parts: [{ text: opts.system + (schema ? "\n\nRespond with a single JSON object only, matching this JSON Schema:\n" + JSON.stringify(z.toJSONSchema(schema)) : "") }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: {
      maxOutputTokens: (opts.maxTokens ?? 4000) + (cheap ? 0 : 4000), // thinking tokens count against the cap on 2.5 models
      temperature: 0.2,
      ...(schema ? { responseMimeType: "application/json" } : {}),
      ...(cheap ? { thinkingConfig: { thinkingBudget: 0 } } : {}),   // no thinking for extraction/judging: cheaper, deterministic
    },
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${env.geminiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const cand = j.candidates?.[0];
  if (!cand || cand.finishReason === "SAFETY") throw new Error(`gemini: no candidate (${cand?.finishReason ?? "empty"})`);
  const text: string = (cand.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
  const u = j.usageMetadata ?? {};
  const usage = {
    input: u.promptTokenCount ?? 0,
    output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheRead: u.cachedContentTokenCount ?? 0,
    cacheWrite: 0,
  };
  if (!schema) return { data: text, usage };
  const parsed = schema.safeParse(JSON.parse(extractJson(text)));
  if (!parsed.success) throw new Error("structured output failed validation: " + parsed.error.message.slice(0, 300));
  return { data: parsed.data, usage };
}

async function viaAnthropic<T>(opts: CallOpts, schema: z.ZodType<T> | null) {
  anthropic ??= new Anthropic({ apiKey: env.anthropicKey || undefined });
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: opts.system, ...(opts.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}) },
  ];
  const base = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4000,
    system,
    messages: [{ role: "user" as const, content: opts.user }],
    ...(opts.model.startsWith("claude-haiku")
      ? {}
      : { thinking: { type: "adaptive" as const }, output_config: { effort: opts.effort ?? "medium" } }),
  };
  let usage: Anthropic.Usage;
  let data: any;
  if (schema) {
    const res = await anthropic.messages.parse({
      ...base,
      output_config: { ...(base as any).output_config, format: zodOutputFormat(schema) },
    });
    usage = res.usage;
    if (res.stop_reason === "refusal") throw new Error("model refused");
    data = res.parsed_output;
    if (data == null) throw new Error("structured output could not be parsed");
  } else {
    const res = await anthropic.messages.create(base);
    usage = res.usage;
    if (res.stop_reason === "refusal") throw new Error("model refused");
    data = res.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
  }
  return {
    data,
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

async function viaOpenRouter<T>(opts: CallOpts, schema: z.ZodType<T> | null) {
  const model = OPENROUTER_MODEL[opts.model] ?? opts.model;
  const body: any = {
    model,
    max_tokens: opts.maxTokens ?? 4000,
    messages: [
      { role: "system", content: opts.system + (schema ? "\n\nRespond with a single JSON object only, matching this JSON Schema:\n" + JSON.stringify(z.toJSONSchema(schema)) : "") },
      { role: "user", content: opts.user },
    ],
    ...(schema ? { response_format: { type: "json_object" } } : {}),
    ...(opts.model.startsWith("claude-haiku") ? {} : { reasoning: { effort: opts.effort ?? "medium" } }),
    usage: { include: true },
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openrouterKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/serbinov/everstake-kb", "X-Title": "everstake-kb" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text: string = j.choices?.[0]?.message?.content ?? "";
  const u = j.usage ?? {};
  const usage = {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
  };
  if (!schema) return { data: text, usage };
  const parsed = schema.safeParse(JSON.parse(extractJson(text)));
  if (!parsed.success) throw new Error("structured output failed validation: " + parsed.error.message.slice(0, 300));
  return { data: parsed.data, usage };
}

/** First balanced JSON object in the text (models sometimes append prose or a second object). */
function extractJson(s: string) {
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start);
}
