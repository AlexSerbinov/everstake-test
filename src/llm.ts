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

export type Stage = "facts" | "answer" | "judge" | "classify" | "embed" | "other";

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

async function call<T>(opts: CallOpts, schema: z.ZodType<T> | null): Promise<LlmResult<any>> {
  const t0 = Date.now();
  try {
    const r = env.llmProvider === "anthropic" ? await viaAnthropic(opts, schema) : await viaOpenRouter(opts, schema);
    const latencyMs = Date.now() - t0;
    const costUsd = priceUsd(opts.model, r.usage);
    const callId = logCall({ stage: opts.stage, provider: env.llmProvider, model: opts.model, ...r.usage, costUsd, latencyMs, meta: opts.meta });
    return { data: r.data, usage: r.usage, costUsd, latencyMs, model: opts.model, provider: env.llmProvider, callId };
  } catch (e: any) {
    logCall({ stage: opts.stage, provider: env.llmProvider, model: opts.model, latencyMs: Date.now() - t0, ok: false, error: String(e?.message ?? e), meta: opts.meta });
    throw e;
  }
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

function extractJson(s: string) {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}
