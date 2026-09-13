import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultEvaluationRun } from "./default-evaluation-run.js";
import type { EvaluationRun } from "./evaluation-page.js";
function run(
  id: string,
  date: string,
  mode = "agent",
  accuracy = 0.7,
): EvaluationRun {
  return {
    id,
    createdAt: date,
    corpusVersion: "frozen",
    plannedTotal: 20,
    mode,
    status: "completed",
    rows: [],
    summary: {
      total: 20,
      completed: 20,
      assessed: 20,
      passed: accuracy * 20,
      failed: 20 - accuracy * 20,
      accuracy,
      inventedFacts: 0,
      knownCostUsd: 0,
      unknownCalls: 0,
    },
  };
}
test("latest full assessed agent wins over a newer baseline, probes and a better historical score", () => {
  const older = run("historical-75", "2026-09-13T14:35:00Z", "agent", 0.75);
  const latest = run("final-70", "2026-09-13T14:49:00Z");
  const baseline = run("baseline-60", "2026-09-13T14:56:00Z", "baseline", 0.6);
  const probe = {
    ...run("probe", "2026-09-13T15:00:00Z"),
    status: "incomplete",
    plannedTotal: 1,
  };
  const pending = {
    ...run("pending", "2026-09-13T15:05:00Z"),
    summary: { ...latest.summary, assessed: 0, accuracy: null },
  };
  const input = [baseline, older, probe, latest, pending];
  assert.equal(defaultEvaluationRun(input)?.id, "final-70");
  assert.deepEqual(
    input.map((item) => item.id),
    ["baseline-60", "historical-75", "probe", "final-70", "pending"],
  );
});
test("fallback preserves visibility of baseline-only or incomplete-only histories", () => {
  const baseline = run("baseline", "2026-09-13T14:00:00Z", "baseline");
  const incomplete = {
    ...run("incomplete", "2026-09-13T15:00:00Z"),
    status: "incomplete",
  };
  assert.equal(defaultEvaluationRun([incomplete, baseline])?.id, "baseline");
  assert.equal(defaultEvaluationRun([incomplete])?.id, "incomplete");
  assert.equal(defaultEvaluationRun([]), undefined);
});
