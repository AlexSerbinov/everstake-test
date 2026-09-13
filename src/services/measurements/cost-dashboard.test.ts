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
