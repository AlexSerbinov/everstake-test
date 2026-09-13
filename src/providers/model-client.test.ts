import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../storage/database.js";
import { beginRun } from "../services/measurements/runs.js";
import { buildReceipt } from "../services/measurements/receipt.js";
import { createEmbeddingClient, createModelClient } from "./model-client.js";
import type { ModelsConfig } from "./provider-config.js";

const config: ModelsConfig = {
  answer: "gemini-3.8-flash",
  extraction: "gemini-3.5-flash-lite",
  embedding: "text-embedding-3-small",
  pricesAsOf: "2026-09-13",
  unknownCallReserveUsd: 0.05,
  providers: {
    gemini: {
      protocol: "native",
      baseURL: "https://gemini.invalid/v1beta",
      apiKeyEnv: "GEMINI_API_KEY",
      timeoutMs: 100,
      maxAttempts: 2,
    },
    openai: {
      baseURL: "https://openai.invalid/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      timeoutMs: 100,
      maxAttempts: 2,
    },
  },
  prices: {
    "gemini-3.8-flash": {
      inputPerMillionUsd: 0.75,
      cachedInputPerMillionUsd: 0.075,
      outputPerMillionUsd: 3.75,
      source: "fixture",
    },
    "gemini-3.5-flash-lite": {
      inputPerMillionUsd: 0.3,
      cachedInputPerMillionUsd: 0.03,
      outputPerMillionUsd: 2.5,
      source: "fixture",
    },
    "text-embedding-3-small": {
      inputPerMillionUsd: 0.02,
      outputPerMillionUsd: 0,
      source: "fixture",
    },
  },
};

test("native Gemini retries transient failures and meters every attempt", async () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "question");
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  let calls = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    calls += 1;
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (calls === 1)
      return Response.json(
        { error: { message: "temporary" } },
        { status: 503 },
      );
    return Response.json({
      responseId: "gemini-request",
      modelVersion: "gemini-3.8-flash",
      candidates: [{ content: { parts: [{ text: "Grounded answer" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 20,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 5,
        totalTokenCount: 115,
      },
    });
  };
  const client = createModelClient(db, {
    config,
    environment: { GEMINI_API_KEY: "test-key" },
    fetch: fakeFetch,
    sleep: async () => undefined,
  });
  const response = await client.generate({
    runId,
    stage: "answer",
    system: "Use evidence.",
    messages: [{ role: "user", text: "Question" }],
    maxOutputTokens: 50,
  });
  assert.deepEqual(response, {
    text: "Grounded answer",
    model: "gemini-3.8-flash",
    inputTokens: 80,
    outputTokens: 15,
  });
  assert.equal(
    requests[0].url,
    "https://gemini.invalid/v1beta/models/gemini-3.8-flash:generateContent",
  );
  assert.equal(requests[0].headers.get("x-goog-api-key"), "test-key");
  assert.equal(requests[0].url.includes("test-key"), false);
  const receipt = buildReceipt(db, runId);
  assert.deepEqual(
    receipt.attempts.map((item) => item.status),
    ["error", "completed"],
  );
  assert.equal(receipt.unknownCalls, 1);
  assert.equal(
    receipt.knownCostUsd,
    (80 * 0.75 + 20 * 0.075 + 15 * 3.75) / 1_000_000,
  );
  db.close();
});

test("a response with usage but invalid content records billable usage on the error row", async () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "question");
  const oneAttempt = structuredClone(config);
  oneAttempt.providers.gemini.maxAttempts = 1;
  const client = createModelClient(db, {
    config: oneAttempt,
    environment: { GEMINI_API_KEY: "test-key" },
    fetch: async () =>
      Response.json({
        modelVersion: "gemini-3.8-flash",
        candidates: [],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 2,
          totalTokenCount: 12,
        },
      }),
  });
  await assert.rejects(
    client.generate({
      runId,
      stage: "answer",
      system: "System",
      messages: [{ role: "user", text: "Question" }],
    }),
    /no text/,
  );
  const receipt = buildReceipt(db, runId);
  assert.equal(receipt.unknownCalls, 0);
  assert.equal(receipt.inputTokens, 10);
  assert.equal(receipt.outputTokens, 2);
  assert.equal(receipt.attempts[0].status, "error");
  db.close();
});

test("OpenAI-compatible Gemini and embeddings use provider usage without model substitution", async () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "question");
  const compatible = structuredClone(config);
  compatible.providers.gemini.protocol = "openai-compatible";
  const seen: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    seen.push(String(input));
    if (String(input).endsWith("/embeddings")) {
      return Response.json({
        model: "text-embedding-3-small",
        data: [{ embedding: [0.1, 0.2] }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });
    }
    return Response.json({
      id: "chat-request",
      model: "gemini-3.5-flash-lite",
      choices: [{ message: { content: "Extracted" } }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });
  };
  const model = createModelClient(db, {
    config: compatible,
    environment: { GEMINI_API_KEY: "gateway-key" },
    fetch: fakeFetch,
  });
  const generated = await model.generate({
    runId,
    stage: "extract",
    model: "gemini-3.5-flash-lite",
    system: "Extract.",
    messages: [{ role: "user", text: "Document" }],
  });
  const embeddings = await createEmbeddingClient(db, {
    config: compatible,
    environment: { OPENAI_API_KEY: "openai-key" },
    fetch: fakeFetch,
  }).embed({ runId, stage: "embed", input: "query" });
  assert.equal(generated.model, "gemini-3.5-flash-lite");
  assert.equal(generated.inputTokens, 20);
  assert.equal(generated.outputTokens, 12);
  assert.deepEqual(embeddings.embeddings, [[0.1, 0.2]]);
  assert.deepEqual(seen, [
    "https://gemini.invalid/v1beta/chat/completions",
    "https://openai.invalid/v1/embeddings",
  ]);
  assert.equal(buildReceipt(db, runId).calls, 2);
  db.close();
});

test("timeouts are separate unknown attempts and never include secrets in stored errors", async () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "question");
  const timeoutConfig = structuredClone(config);
  timeoutConfig.providers.gemini.timeoutMs = 5;
  timeoutConfig.providers.gemini.maxAttempts = 2;
  const client = createModelClient(db, {
    config: timeoutConfig,
    environment: { GEMINI_API_KEY: "AIza-secret-value-that-must-not-leak" },
    sleep: async () => undefined,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("Bearer secret-token timed out")),
        );
      }),
  });
  const rejected = await assert.rejects(
    client.generate({
      runId,
      stage: "answer",
      system: "",
      messages: [{ role: "user", text: "Question" }],
    }),
    /timed out/,
  );
  assert.equal(String(rejected).includes("secret-token"), false);
  const receipt = buildReceipt(db, runId);
  assert.deepEqual(
    receipt.attempts.map((item) => item.status),
    ["timed_out", "timed_out"],
  );
  assert.equal(receipt.unknownCalls, 2);
  assert.equal(
    receipt.attempts.every((item) => !item.error?.includes("secret-token")),
    true,
  );
  db.close();
});
