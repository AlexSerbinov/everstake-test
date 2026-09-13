import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../storage/database.js";
import {
  beginApiAttempt,
  BudgetExceededError,
  finishApiAttempt,
} from "./api-calls.js";
import {
  calculateCost,
  normalizeGeminiUsage,
  normalizeOpenAiUsage,
} from "./pricing.js";
import { buildReceipt, costOverview } from "./receipt.js";
import { beginRun, finishRun, withRun } from "./runs.js";
import type { PriceSnapshot } from "./types.js";

const price: PriceSnapshot = {
  model: "gemini-test",
  pricesAsOf: "2026-09-13",
  source: "fixture",
  inputPerMillionUsd: 1,
  cachedInputPerMillionUsd: 0.1,
  outputPerMillionUsd: 2,
};

test("usage normalization keeps cached and thinking tokens mutually exclusive", () => {
  const gemini = normalizeGeminiUsage({
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 5,
    totalTokenCount: 125,
  });
  assert.deepEqual(
    gemini && {
      input: gemini.inputTokens,
      cached: gemini.cachedInputTokens,
      output: gemini.outputTokens,
      visible: gemini.visibleOutputTokens,
      thinking: gemini.thinkingTokens,
    },
    { input: 60, cached: 40, output: 25, visible: 20, thinking: 5 },
  );
  assert.equal(calculateCost(gemini!, price), (60 + 4 + 50) / 1_000_000);

  const openai = normalizeOpenAiUsage({
    prompt_tokens: 80,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 50 },
    completion_tokens_details: { reasoning_tokens: 12 },
  });
  assert.deepEqual(
    openai && {
      input: openai.inputTokens,
      cached: openai.cachedInputTokens,
      output: openai.outputTokens,
      visible: openai.visibleOutputTokens,
      thinking: openai.thinkingTokens,
    },
    { input: 30, cached: 50, output: 30, visible: 18, thinking: 12 },
  );
  assert.equal(normalizeGeminiUsage({ promptTokenCount: 2 }), null);
  assert.equal(
    normalizeGeminiUsage({
      promptTokenCount: 2,
      candidatesTokenCount: 1,
      cachedContentTokenCount: 3,
    }),
    null,
  );
});

test("receipt includes retries, failures, unknown cost, and nested calls once", async () => {
  const db = openDatabase(":memory:");
  const parent = beginRun(db, "evaluation");
  const child = await withRun(
    db,
    "question",
    async (runId) => {
      const failed = beginApiAttempt(db, {
        runId,
        stage: "answer",
        provider: "gemini",
        model: "gemini-test",
        attempt: 1,
        operationId: "op-1",
        reservationUsd: 0.05,
      });
      finishApiAttempt(db, failed, {
        status: "error",
        elapsedMs: 12,
        error: "HTTP 503",
      });
      const success = beginApiAttempt(db, {
        runId,
        stage: "answer",
        provider: "gemini",
        model: "gemini-test",
        attempt: 2,
        operationId: "op-1",
        reservationUsd: 0.05,
      });
      finishApiAttempt(db, success, {
        status: "completed",
        elapsedMs: 20,
        price,
        usage: {
          inputTokens: 60,
          cachedInputTokens: 40,
          outputTokens: 25,
          visibleOutputTokens: 20,
          thinkingTokens: 5,
          raw: { fixture: true },
        },
        providerRequestId: "request-2",
      });
      return runId;
    },
    { parentRunId: parent },
  );
  finishRun(db, parent, "completed");

  const receipt = buildReceipt(db, parent);
  assert.equal(receipt.calls, 2);
  assert.equal(receipt.unknownCalls, 1);
  assert.equal(receipt.knownCostUsd, 0.000114);
  assert.deepEqual(
    receipt.attempts.map((item) => item.attempt),
    [1, 2],
  );
  assert.equal(receipt.attempts[1].thinkingTokens, 5);
  assert.equal(buildReceipt(db, child).calls, 2);

  const overview = costOverview(db);
  assert.equal(overview.calls, 2);
  assert.equal(overview.knownCostUsd, receipt.knownCostUsd);
  assert.equal(overview.unknownCalls, 1);
  db.close();
});

test("budget reservations serialize concurrent attempts and unknown costs stay reserved", () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "question");
  const caps = {
    runUsd: 0.09,
    sessionUsd: 1,
    sessionStartedAt: "2000-01-01T00:00:00.000Z",
  };
  const first = beginApiAttempt(
    db,
    {
      runId,
      stage: "answer",
      provider: "gemini",
      model: "gemini-test",
      attempt: 1,
      operationId: "one",
      reservationUsd: 0.05,
    },
    caps,
  );
  assert.throws(
    () =>
      beginApiAttempt(
        db,
        {
          runId,
          stage: "answer",
          provider: "gemini",
          model: "gemini-test",
          attempt: 1,
          operationId: "two",
          reservationUsd: 0.05,
        },
        caps,
      ),
    (error: unknown) =>
      error instanceof BudgetExceededError && error.scope === "run",
  );

  finishApiAttempt(db, first, {
    status: "completed",
    elapsedMs: 1,
    price,
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      raw: {},
    },
  });
  const second = beginApiAttempt(
    db,
    {
      runId,
      stage: "answer",
      provider: "gemini",
      model: "gemini-test",
      attempt: 1,
      operationId: "two",
      reservationUsd: 0.05,
    },
    caps,
  );
  finishApiAttempt(db, second, {
    status: "timed_out",
    elapsedMs: 5,
    error: "timeout",
  });
  assert.throws(
    () =>
      beginApiAttempt(
        db,
        {
          runId,
          stage: "answer",
          provider: "gemini",
          model: "gemini-test",
          attempt: 2,
          operationId: "two",
          reservationUsd: 0.05,
        },
        caps,
      ),
    BudgetExceededError,
  );
  assert.equal(buildReceipt(db, runId).unknownCalls, 1);
  db.close();
});

test("non-token providers can record an actual unit-priced charge", () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "youtube_transcription");
  const attemptId = beginApiAttempt(db, {
    runId,
    stage: "transcribe",
    provider: "soniox",
    model: "stt-async",
    attempt: 1,
    operationId: "audio-1",
    reservationUsd: 0.2,
    metadata: { mediaSeconds: 120 },
  });
  finishApiAttempt(db, attemptId, {
    status: "completed",
    elapsedMs: 2_000,
    actualCostUsd: 0.0125,
    providerRequestId: "stt-request",
    metadata: { billedAudioTokens: 8_333, costMethod: "provider_usage" },
  });
  const receipt = buildReceipt(db, runId);
  assert.equal(receipt.knownCostUsd, 0.0125);
  assert.equal(receipt.unknownCalls, 0);
  assert.equal(
    receipt.inputTokens,
    0,
    "audio units are not mislabeled as text tokens",
  );
  db.close();
});

test("missing model prices remain unknown instead of becoming zero", () => {
  const db = openDatabase(":memory:");
  const runId = beginRun(db, "question");
  const attemptId = beginApiAttempt(db, {
    runId,
    stage: "answer",
    provider: "gemini",
    model: "unpriced-model",
    attempt: 1,
    operationId: "unknown-price",
    reservationUsd: 0.05,
  });
  finishApiAttempt(db, attemptId, {
    status: "completed",
    elapsedMs: 4,
    price: null,
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, raw: {} },
  });
  const receipt = buildReceipt(db, runId);
  assert.equal(receipt.knownCostUsd, 0);
  assert.equal(receipt.unknownCalls, 1);
  assert.equal(receipt.attempts[0].costUsd, null);
  db.close();
});

test("AsyncLocalStorage assigns the active parent to overlapping child runs", async () => {
  const db = openDatabase(":memory:");
  const parents = await Promise.all(
    ["a", "b"].map((kind) =>
      withRun(db, kind, async (parentId) => {
        await new Promise((resolve) => setImmediate(resolve));
        const childId = beginRun(db, "child");
        finishRun(db, childId, "completed");
        return { parentId, childId };
      }),
    ),
  );
  for (const pair of parents) {
    const row = db
      .prepare("SELECT metadata FROM runs WHERE id = ?")
      .get(pair.childId) as { metadata: string };
    assert.equal(JSON.parse(row.metadata).parentRunId, pair.parentId);
  }
  assert.notEqual(parents[0].parentId, parents[1].parentId);
  db.close();
});
