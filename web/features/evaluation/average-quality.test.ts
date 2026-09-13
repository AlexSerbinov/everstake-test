import assert from "node:assert/strict";
import test from "node:test";
import { averageQuality } from "./average-quality.js";
import type { EvaluationRun } from "./evaluation-page.js";

const fixture = (correctness: number | null): EvaluationRun => ({
  plannedTotal: 2,
  rows: [40, correctness].map((value) => ({
    qualityScore: value === null ? undefined : {
      correctness: value, completeness: 30, grounding: 20, uncertainty: 10,
      reason: "Saved rubric assessment",
    },
  })),
} as EvaluationRun);

test("averages recorded partial credit without turning it into a pass rate", () => {
  assert.equal(averageQuality(fixture(20)), 90);
});
test("missing, invalid or incomplete grades do not produce a headline score", () => {
  assert.equal(averageQuality(fixture(null)), null);
  assert.equal(averageQuality(fixture(41)), null);
  assert.equal(averageQuality({ ...fixture(40), plannedTotal: 20 }), null);
});
