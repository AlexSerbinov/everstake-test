import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvaluationRun } from "./evaluation-page.js";
import { publicEvaluations } from "./current-evaluation.js";
function fixture(): EvaluationRun {
  return {
    id: "base",
    createdAt: "2026-01-01",
    corpusVersion: "frozen",
    questionSetVersion: "v2",
    mode: "agent",
    status: "completed",
    plannedTotal: 20,
    rows: Array.from({ length: 20 }, (_, i) => ({
      question: `Q${i}`,
      answer: null,
      verdict: i < 14 ? "pass" : "fail",
      inventedFacts: false,
    })),
    summary: {
      total: 20,
      completed: 20,
      assessed: 20,
      passed: 14,
      failed: 6,
      accuracy: 0.7,
      inventedFacts: 0,
      knownCostUsd: 1,
      unknownCalls: 0,
    },
  };
}
function recheck(base: EvaluationRun): EvaluationRun {
  return {
    ...base,
    id: "repair",
    createdAt: "2026-01-02",
    recheckOf: base.id,
    plannedTotal: 2,
    rows: base.rows.slice(14, 16).map((row) => ({ ...row, verdict: "pass" })),
    summary: {
      ...base.summary,
      total: 2,
      completed: 2,
      assessed: 2,
      passed: 2,
      failed: 0,
      accuracy: 1,
      knownCostUsd: 0.1,
    },
  };
}
test("public summary hides baseline, applies rechecks and preserves original runs", () => {
  const base = fixture(),
    repair = recheck(base),
    saved = [base, repair, { ...base, id: "baseline", mode: "baseline" }];
  const result = publicEvaluations(saved),
    current = result[0]!;
  assert.equal(
    result.some((run) => run.mode === "baseline"),
    false,
  );
  assert.equal(current.summary.passed, 16);
  assert.equal(current.summary.failed, 4);
  assert.equal(current.rows.length, 20);
  assert.equal(current.recheckedCount, 2);
  assert.equal(current.summary.knownCostUsd, 1.1);
  assert.equal(base.summary.passed, 14);
  assert.equal(base.rows[14]!.verdict, "fail");
  assert.deepEqual(current.sourceRunIds, ["base", "repair"]);
});
test("newer failed rechecks replace earlier successes; never select the best score", () => {
  const base = fixture(),
    first = recheck(base),
    second = {
      ...first,
      id: "later",
      createdAt: "2026-01-03",
      rows: first.rows.map((row) => ({ ...row, verdict: "fail" })),
    };
  const current = publicEvaluations([second, base, first])[0]!;
  assert.equal(current.summary.passed, 14);
  assert.equal(current.recheckedCount, 2);
});
test("incompatible, duplicate and unassessed rechecks do not alter the summary", () => {
  const base = fixture(),
    repair = recheck(base);
  for (const invalid of [
    { ...repair, corpusVersion: "changed" },
    { ...repair, questionSetVersion: "changed" },
    { ...repair, rows: [repair.rows[0]!, repair.rows[0]!] },
    {
      ...repair,
      rows: [{ ...repair.rows[0]!, question: "Unrelated" }, repair.rows[1]!],
    },
    { ...repair, summary: { ...repair.summary, assessed: 0 } },
  ])
    assert.equal(
      publicEvaluations([base, invalid]).some(
        (run) => run.viewKind === "updated",
      ),
      false,
    );
});
