import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { costDashboard } from "./cost-dashboard.js";

test("empty ledger has no invented query mean or dates", () => {
  const db = openDatabase(":memory:");
  try {
    const result = costDashboard(db);
    assert.equal(result.calls, 0);
    assert.equal(result.query.meanUsd, null);
    assert.deepEqual(result.daily, []);
    assert.deepEqual(result.runs, []);
    assert.equal(result.forecast.projectedIndexCostUsd, 0);
    assert.equal(result.forecast.documents, 0);
    assert.equal(result.forecast.projectedDocuments, 0);
  } finally {
    db.close();
  }
});
test("purpose, daily and root receipts count nested calls once; pricing and failure states stay distinct", () => {
  const db = openDatabase(":memory:");
  try {
    const run = (
      id: string,
      kind: string,
      metadata: object = {},
      status = "completed",
    ) =>
      db
        .prepare("INSERT INTO runs VALUES(?,?,?, ?,?,?)")
        .run(
          id,
          kind,
          "2026-09-12T10:00:00Z",
          "2026-09-12T10:00:05Z",
          status,
          JSON.stringify(metadata),
        );
    const call = (
      id: string,
      runId: string,
      cost: number | null,
      status = "completed",
      stage = "answer",
      day = "12",
    ) =>
      db
        .prepare("INSERT INTO api_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          runId,
          stage,
          "test",
          "fixture",
          `2026-09-${day}T10:00:01Z`,
          100,
          10,
          2,
          cost,
          status,
          "{}",
        );
    run("eval", "evaluation");
    run("q", "query", { parentRunId: "eval", question: "How much?" });
    run("verify", "verification", { parentRunId: "q" });
    run("q2", "query", { question: "Another question" });
    run("q3", "query", { question: "Unknown charge" });
    run("index", "index");
    call("1", "eval", 1);
    call("2", "q", 2);
    call("3", "verify", 3);
    call("4", "q2", 7);
    call("5", "q3", null, "error");
    call("6", "q3", null, "pending");
    call("7", "index", 4, "completed", "embedding", "13");
    const result = costDashboard(db);
    assert.equal(result.knownCostUsd, 17);
    assert.equal(
      result.byPurpose.find((row) => row.label === "evaluation")?.knownCostUsd,
      6,
    );
    assert.equal(
      result.byPurpose.reduce((sum, row) => sum + row.knownCostUsd, 0),
      17,
    );
    assert.equal(
      result.runs.reduce((sum, row) => sum + row.receipt.knownCostUsd, 0),
      17,
    );
    assert.equal(
      result.runs
        .find((row) => row.id === "eval")
        ?.childRuns.find((child) => child.id === "q")?.question,
      null,
    );
    assert.equal(result.runs.find((row) => row.id === "q2")?.question, null);
    assert.ok(!JSON.stringify(result).includes("How much?"));
    assert.ok(!JSON.stringify(result).includes("Another question"));
    assert.equal(result.query.meanUsd, 6);
    assert.equal(result.query.minUsd, 5);
    assert.equal(result.query.maxUsd, 7);
    assert.equal(result.query.excludedRuns, 1);
    assert.equal(result.pendingCalls, 1);
    assert.equal(result.unpricedFinalCalls, 1);
    assert.equal(result.unknownCalls, 2);
    assert.equal(result.errorCalls, 1);
    assert.deepEqual(
      result.daily.map((row) => row.knownCostUsd),
      [13, 4],
    );
    assert.equal(result.forecast.projectedIndexCostUsd, 200);
  } finally {
    db.close();
  }
});
test("orphan parents do not hide activity and malformed metadata cannot crash dashboard", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)").run(
      "orphan",
      "query",
      "2026-09-12T00:00:00Z",
      null,
      "running",
      JSON.stringify({ parentRunId: "missing" }),
    );
    db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)").run(
      "bad",
      "index",
      "2026-09-12T00:00:00Z",
      null,
      "running",
      "invalid-json",
    );
    const result = costDashboard(db);
    assert.equal(result.totalRootRuns, 2);
    assert.equal(result.runs.length, 2);
    assert.equal(result.query.meanUsd, null);
  } finally {
    db.close();
  }
});

test("query embeddings never inflate the index construction forecast", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)").run(
      "q",
      "query",
      "2026-09-12T00:00:00Z",
      "2026-09-12T00:00:01Z",
      "completed",
      "{}",
    );
    db.prepare("INSERT INTO api_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "c",
      "q",
      "query-embedding",
      "openai",
      "embedding",
      "2026-09-12T00:00:00Z",
      10,
      100,
      0,
      0.01,
      "completed",
      "{}",
    );
    const result = costDashboard(db);
    assert.equal(result.knownCostUsd, 0.01);
    assert.equal(result.query.meanUsd, 0.01);
    assert.equal(result.index.knownCostUsd, 0);
    assert.equal(result.forecast.projectedIndexCostUsd, 0);
  } finally {
    db.close();
  }
});

test("update averages use completed priced refresh roots once, including nested video/model work", () => {
  const db = openDatabase(":memory:");
  try {
    const run = (
      id: string,
      kind: string,
      status = "completed",
      metadata: object = {},
    ) =>
      db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)")
        .run(
          id,
          kind,
          "2026-09-13T10:00:00Z",
          status === "running" ? null : "2026-09-13T10:01:00Z",
          status,
          JSON.stringify(metadata),
        );
    const call = (
      id: string,
      runId: string,
      provider: string,
      model: string,
      cost: number | null,
      status = "completed",
    ) =>
      db
        .prepare("INSERT INTO api_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          runId,
          "fixture",
          provider,
          model,
          "2026-09-13T10:00:01Z",
          10,
          100,
          5,
          cost,
          status,
          "{}",
        );
    run("web", "refresh");
    run("review", "youtube_speaker_review", "completed", {
      parentRunId: "web",
    });
    run("nested", "refresh", "completed", { parentRunId: "web" });
    run("video-update", "refresh", "completed", { sourceId: "youtube" });
    run("failed", "refresh", "failed");
    run("unpriced", "refresh");
    run("running", "refresh", "running");
    run("standalone-video", "youtube_video");
    call("a", "web", "openai", "text-embedding-3-small", 1);
    call("b", "review", "gemini", "gemini-3.8-flash", 2);
    call("c", "nested", "gemini", "gemini-3.5-flash-lite", 3);
    call("d", "video-update", "soniox", "stt-async-v5", 4);
    call("e", "failed", "gemini", "gemini-3.8-flash", 10, "error");
    call("f", "unpriced", "soniox", "stt-async-v5", null);
    call("g", "running", "openai", "text-embedding-3-small", 20);
    call("h", "standalone-video", "soniox", "stt-async-v5", 7);
    const result = costDashboard(db);
    assert.deepEqual(result.update, {
      runs: 5,
      measuredRuns: 2,
      excludedRuns: 3,
      meanUsd: 5,
      minUsd: 4,
      maxUsd: 6,
      knownCostUsd: 40,
    });
    assert.equal(result.knownCostUsd, 47);
    assert.equal(
      result.byProvider.reduce(
        (sum, provider) => sum + provider.knownCostUsd,
        0,
      ),
      47,
    );
    const soniox = result.byProvider.find(
      (provider) => provider.provider === "soniox",
    )!;
    assert.equal(soniox.knownCostUsd, 11);
    assert.equal(soniox.unpricedFinalCalls, 1);
    assert.equal(soniox.pendingCalls, 0);
    const gemini = result.byProvider.find(
      (provider) => provider.provider === "gemini",
    )!;
    assert.equal(gemini.knownCostUsd, 15);
    assert.equal(gemini.errorCalls, 1);
    assert.deepEqual(
      gemini.models.map((model) => [model.model, model.knownCostUsd]),
      [
        ["gemini-3.8-flash", 12],
        ["gemini-3.5-flash-lite", 3],
      ],
    );
    assert.equal(
      result.byProvider.find((provider) => provider.provider === "openai")!
        .inputTokens,
      200,
    );
  } finally {
    db.close();
  }
});

test("missing update samples stay null and unexpected providers remain accounted for", () => {
  const db = openDatabase(":memory:");
  try {
    let result = costDashboard(db);
    assert.equal(result.update.meanUsd, null);
    assert.equal(result.update.measuredRuns, 0);
    assert.equal(result.byProvider.length, 3);
    assert.ok(
      result.byProvider.every(
        (provider) => provider.calls === 0 && provider.models.length === 0,
      ),
    );
    db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?)").run(
      "q",
      "query",
      "2026-09-13T10:00:00Z",
      null,
      "running",
      "{}",
    );
    db.prepare("INSERT INTO api_calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "other",
      "q",
      "fixture",
      "new-provider",
      "new-model",
      "2026-09-13T10:00:00Z",
      1,
      null,
      null,
      null,
      "pending",
      "{}",
    );
    result = costDashboard(db);
    assert.equal(result.byProvider.length, 4);
    assert.equal(
      result.byProvider.find(
        (provider) => provider.provider === "new-provider",
      )!.pendingCalls,
      1,
    );
    assert.equal(
      result.byProvider.reduce(
        (sum, provider) => sum + provider.unknownCalls,
        0,
      ),
      1,
    );
    assert.equal(result.update.meanUsd, null);
  } finally {
    db.close();
  }
});
