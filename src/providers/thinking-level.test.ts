import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRequest } from "../contracts.js";
import { nativeGeminiRequest } from "./gemini.js";
import { openAiGenerationRequest } from "./openai.js";

const request: ModelRequest = {
  runId: "fixture",
  stage: "answer-scope-review",
  system: "Return JSON",
  messages: [{ role: "user", text: "Compare the evidence" }],
  maxOutputTokens: 1500,
};
test("bounded review thinking is transmitted through both supported Gemini transports", () => {
  const low = { ...request, thinkingLevel: "low" as const };
  assert.deepEqual(
    nativeGeminiRequest(low, "gemini-3.8-flash").generationConfig,
    { maxOutputTokens: 1500, thinkingConfig: { thinkingLevel: "low" } },
  );
  assert.equal(
    openAiGenerationRequest(low, "gemini-3.8-flash").reasoning_effort,
    "low",
  );
});
test("calls that do not request a thinking level, including cheap reviews, keep their provider defaults", () => {
  assert.deepEqual(
    nativeGeminiRequest(request, "gemini-3.5-flash-lite").generationConfig,
    { maxOutputTokens: 1500 },
  );
  assert.equal(
    "reasoning_effort" in
      openAiGenerationRequest(request, "gemini-3.5-flash-lite"),
    false,
  );
});
