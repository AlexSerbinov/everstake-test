// The two pure functions in the LLM layer: the price table lookup that produces every cost
// figure in the report, and the provider model mapping. No network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { env, getConfig } from "./config.js";
import { priceUsd, resolveModel } from "./llm.js";

test("price is per million tokens across all four usage buckets", () => {
  const p = getConfig().pricing_usd_per_mtok["claude-opus-5"];
  assert.equal(priceUsd("claude-opus-5", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
    p.input + p.output + p.cache_read! + p.cache_write!);
  assert.equal(priceUsd("claude-opus-5", { input: 500_000, output: 0 }), p.input / 2);
  assert.equal(priceUsd("text-embedding-3-small", { input: 1_000_000, output: 0 }), 0.02);
});

// a model with no cache pricing must charge zero for cache tokens, not NaN — a NaN here would
// poison SUM(cost_usd) for the whole stage and silently zero out the cost report
test("missing cache prices and unknown models cost zero rather than NaN", () => {
  assert.equal(priceUsd("gemini-unknown-model", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }), 0);
  assert.equal(priceUsd("no-such-model", { input: 1_000_000, output: 1_000_000 }), 0);
  assert.equal(priceUsd("claude-opus-5", { input: 0, output: 0 }), 0);
});

test("model names pass through unchanged unless the provider is Gemini", () => {
  const provider = env.llmProvider;
  try {
    (env as any).llmProvider = "anthropic";
    assert.equal(resolveModel("claude-opus-5"), "claude-opus-5");
    assert.equal(resolveModel("claude-haiku-4-5"), "claude-haiku-4-5");
    (env as any).llmProvider = "openrouter";
    assert.equal(resolveModel("claude-opus-5"), "claude-opus-5", "the OpenRouter slug is applied later, at call time");
  } finally { (env as any).llmProvider = provider; }
});

// config/kb.yaml names Claude models even when the build runs on Gemini; the mapping is by
// family, so any claude-haiku-* becomes the cheap model and everything else the answer model
test("on Gemini a Claude name maps to the cheap or the answer model by family", () => {
  const provider = env.llmProvider;
  try {
    (env as any).llmProvider = "gemini";
    assert.equal(resolveModel("claude-haiku-4-5"), env.geminiCheapModel);
    assert.equal(resolveModel("claude-opus-5"), env.geminiAnswerModel);
    assert.equal(resolveModel("claude-sonnet-5"), env.geminiAnswerModel, "anything that is not haiku is an answer model");
    assert.equal(resolveModel("gemini-3.7-flash"), "gemini-3.7-flash", "an explicit Gemini name is never remapped");
  } finally { (env as any).llmProvider = provider; }
});

// --- extractFirstJsonObject -----------------------------------------------------------
// The salvage step between a model's reply and `JSON.parse`, on the two providers that get
// the schema as prose rather than natively (Gemini, OpenRouter). These pin the shapes really
// observed from those providers, so a "cleanup" of the scanner cannot quietly break them.
import { extractFirstJsonObject } from "./llm.js";

test("a fenced code block, leading prose and trailing prose are all stripped", () => {
  assert.equal(extractFirstJsonObject('```json\n{"answer":"yes"}\n```'), '{"answer":"yes"}');
  assert.equal(extractFirstJsonObject('Sure, here is the result:\n{"answer":"yes"}'), '{"answer":"yes"}');
  assert.equal(extractFirstJsonObject('{"answer":"yes"}\n\nLet me know if you need more.'), '{"answer":"yes"}');
  assert.equal(extractFirstJsonObject('Here:\n```json\n{"answer":"yes"}\n```\nHope that helps.'), '{"answer":"yes"}');
});

// the reason this is a brace-depth scan and not indexOf('{') + lastIndexOf('}'): a second
// object after the first must be dropped, not merged into the slice
test("only the first balanced object is returned when the model emits two", () => {
  assert.equal(extractFirstJsonObject('{"a":1}\n{"b":2}'), '{"a":1}');
  assert.equal(extractFirstJsonObject('use {} for empty, then {"a":1}'), "{}", "the first object wins even when it is empty");
});

test("nested objects are kept whole", () => {
  assert.equal(extractFirstJsonObject('{"outer":{"inner":{"n":1}},"tail":2} trailing'), '{"outer":{"inner":{"n":1}},"tail":2}');
});

// braces and quotes inside a JSON string literal must not move the depth counter — quoted
// text is exactly what the fact extractor returns, so this is the common case, not an edge one
test("braces and quotes inside string values do not end the object early", () => {
  assert.equal(extractFirstJsonObject('{"quote":"a } b { c"}'), '{"quote":"a } b { c"}');
  assert.equal(extractFirstJsonObject('{"quote":"he said \\"} done\\" loudly"}'), '{"quote":"he said \\"} done\\" loudly"}');
  assert.equal(extractFirstJsonObject('{"quote":"ends with a backslash \\\\"} after'), '{"quote":"ends with a backslash \\\\"}');
});

// both fall through to the caller's JSON.parse, which raises a better error than this
// function could — it can see the schema and the stage, this cannot
test("input with no object, or an unterminated one, is passed through rather than throwing", () => {
  assert.equal(extractFirstJsonObject("I cannot answer that."), "I cannot answer that.");
  assert.equal(extractFirstJsonObject(""), "");
  assert.equal(extractFirstJsonObject('prose then {"a":1'), '{"a":1', "everything from the first brace on");
});
