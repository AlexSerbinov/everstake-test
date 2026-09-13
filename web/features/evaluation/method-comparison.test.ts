import { test } from "node:test";
import assert from "node:assert/strict";
import { comparableRuns, questionKey } from "./method-comparison.js";
import type { EvaluationRun } from "./evaluation-page.js";
import type { EvaluationQuestion } from "../../../src/contracts.js";
function run(id: string, mode: string, createdAt: string): EvaluationRun {
  return {
    id,
    mode,
    createdAt,
    corpusVersion: mode === "mcp" ? "everstake-mcp@68f5f5f" : "frozen",
    plannedTotal: 20,
    status: "completed",
    rows: Array.from({ length: 20 }, (_, i) => ({
      question: {
        id: `E${i + 1}`,
        question: `Question ${i + 1}?`,
        difficulty: i < 5 ? "basic" : "hard",
        negative: i >= 15,
        reference: "Expected",
        rubric: [],
        referenceUrls: [],
        category: "test",
        whyHard: "",
      } satisfies EvaluationQuestion,
      answer: null,
      verdict: "pass",
    })),
    summary: {
      total: 20,
      completed: 20,
      assessed: 20,
      passed: 20,
      failed: 0,
      accuracy: 1,
      inventedFacts: 0,
      knownCostUsd: 0.12,
      unknownCalls: 0,
    },
  };
}
test("comparison picks latest full same-question runs, never best scores or partial probes", () => {
  const agent = run("agent", "agent", "2026-09-13T12:00:00Z");
  const old = run("old", "baseline", "2026-09-13T11:00:00Z");
  const latest = run("new", "baseline", "2026-09-13T13:00:00Z");
  latest.summary.accuracy = 0.5;
  const probe = run("probe", "baseline", "2026-09-13T14:00:00Z");
  probe.rows = probe.rows.slice(0, 2);
  const mismatched = run("mismatched", "mcp", "2026-09-13T15:00:00Z");
  (mismatched.rows[0].question as EvaluationQuestion).question =
    "Changed question?";
  const input = [old, agent, probe, mismatched, latest];
  assert.deepEqual(Object.keys(comparableRuns(input)).sort(), [
    "agent",
    "baseline",
  ]);
  assert.equal(comparableRuns(input).baseline?.id, "new");
  assert.equal(input[0].id, "old");
});
test("pending assessment stays visible as the newest saved MCP run without inventing a grade", () => {
  const agent = run("agent", "agent", "2026-09-13T12:00:00Z");
  const mcp = run("mcp-pending", "mcp", "2026-09-13T13:00:00Z");
  mcp.rows.forEach((row) => {
    row.verdict = "pending";
  });
  Object.assign(mcp.summary, {
    assessed: 0,
    passed: 0,
    failed: 0,
    accuracy: null,
    inventedFacts: null,
  });
  const selected = comparableRuns([agent, mcp]);
  assert.equal(selected.mcp?.id, "mcp-pending");
  assert.equal(selected.mcp?.summary.accuracy, null);
});
test("question order can differ but duplicate IDs and texts cannot masquerade as twenty questions", () => {
  const agent = run("agent", "agent", "2026-09-13T12:00:00Z");
  const mcp = run("mcp", "mcp", "2026-09-13T13:00:00Z");
  mcp.rows.reverse();
  assert.equal(comparableRuns([agent, mcp]).mcp?.id, "mcp");
  assert.equal(questionKey(agent.rows[0]), questionKey(mcp.rows[19]));
  mcp.rows[0] = mcp.rows[1];
  assert.equal(comparableRuns([agent, mcp]).mcp, undefined);
  assert.deepEqual(comparableRuns([]), {});
});
