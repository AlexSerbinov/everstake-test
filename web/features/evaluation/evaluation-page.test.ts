import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRows } from "./evaluation-page.js";
import type { ResultRow } from "./question-result-card.js";
test("filtering mixed saved results never removes or modifies the full denominator", () => {
  const rows: ResultRow[] = [
    "correct",
    "partial",
    "wrong",
    "ungraded",
    "correct_abstention",
  ].map((verdict) => ({ question: "Question", answer: null, verdict }));
  assert.equal(filterRows(rows, "all").length, 5);
  assert.equal(filterRows(rows, "wrong").length, 1);
  assert.equal(filterRows(rows, "partial")[0].verdict, "partial");
  assert.equal(rows.length, 5);
});

import { evaluationMetrics } from "./evaluation-metrics.js";
import type { EvaluationRun } from "./evaluation-page.js";
const incompleteRun: EvaluationRun = {
  id: "saved-run",
  createdAt: "2026-09-13",
  corpusVersion: "frozen",
  plannedTotal: 20,
  mode: "agent",
  status: "incomplete",
  rows: [],
  summary: {
    total: 20,
    completed: 3,
    assessed: 2,
    passed: 1,
    failed: 1,
    accuracy: null,
    inventedFacts: null,
    knownCostUsd: 0.1,
    unknownCalls: 1,
  },
};
test("incomplete API assessment keeps accuracy unknown and separates unrun from unassessed requests", () => {
  const progress = evaluationMetrics(incompleteRun);
  assert.equal(progress.accuracy, "Incomplete");
  assert.equal(progress.notRun, 17);
  assert.equal(progress.awaitingAssessment, 1);
  assert.equal(progress.assessmentComplete, false);
});
test("a fully assessed run displays the saved API accuracy without inferring results from filters", () => {
  const run = {
    ...incompleteRun,
    summary: {
      ...incompleteRun.summary,
      completed: 20,
      assessed: 20,
      passed: 16,
      failed: 4,
      accuracy: 0.8,
    },
  };
  assert.equal(evaluationMetrics(run).accuracy, "80.0%");
  assert.equal(evaluationMetrics(run).assessmentComplete, true);
});
