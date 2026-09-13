import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupMetrics,
  resultState,
  selectResults,
} from "./evaluation-groups.js";
import { evaluationMetrics } from "./evaluation-metrics.js";
import { savedAnswerSegments, type ResultRow } from "./question-result-card.js";
import type {
  AnswerResult,
  EvaluationQuestion,
} from "../../../src/contracts.js";
import type { EvaluationRun } from "./evaluation-page.js";
const question = (
  difficulty: "basic" | "hard",
  negative = false,
): EvaluationQuestion => ({
  id: "q",
  question: "Question?",
  difficulty,
  negative,
  reference: "Reference",
  referenceUrls: [],
  whyHard: "Reason",
  rubric: [],
  category: "test",
});
const rows: ResultRow[] = [
  { question: question("basic"), answer: null, verdict: "pass" },
  { question: question("hard"), answer: null, verdict: "partial" },
  {
    question: question("hard", true),
    answer: null,
    verdict: "correct_abstention",
  },
  { question: question("basic", true), answer: null, verdict: "pending" },
];
test("difficulty partitions saved rows; negative cases overlap and never become a third difficulty", () => {
  assert.equal(
    groupMetrics(rows, "simple").total + groupMetrics(rows, "hard").total,
    rows.length,
  );
  assert.deepEqual(groupMetrics(rows, "negative"), {
    total: 2,
    passed: 1,
    checked: 1,
    accuracy: null,
  });
  assert.deepEqual(groupMetrics(rows, "hard"), {
    total: 2,
    passed: 1,
    checked: 2,
    accuracy: 0.5,
  });
  assert.equal(groupMetrics(rows, "all").accuracy, null);
  assert.equal(groupMetrics([], "all").accuracy, null);
});
test("group and outcome filters intersect without changing inputs or denominators", () => {
  assert.deepEqual(selectResults(rows, "hard", "failed"), [rows[1]]);
  assert.deepEqual(selectResults(rows, "negative", "passed"), [rows[2]]);
  assert.deepEqual(selectResults(rows, "all", "ungraded"), [rows[3]]);
  assert.equal(groupMetrics(rows, "all").total, 4);
  assert.equal(
    selectResults(
      [{ question: "Legacy question", answer: null, verdict: "" }],
      "simple",
      "all",
    ).length,
    0,
  );
});
test("request errors remain errors even if marked correct; graded errors contribute to checked, never passed", () => {
  const error = {
    ...rows[0],
    answer: { status: "error" } as AnswerResult,
    verdict: "fail",
  };
  assert.equal(resultState(error), "error");
  assert.deepEqual(groupMetrics([error], "all"), {
    total: 1,
    passed: 0,
    checked: 1,
    accuracy: 0,
  });
  assert.equal(resultState({ ...error, verdict: "pass" }), "error");
});
test("saved partial accuracy cannot present a complete run score", () => {
  const run = {
    plannedTotal: 20,
    rows: [],
    summary: {
      total: 20,
      completed: 20,
      assessed: 19,
      passed: 19,
      failed: 0,
      accuracy: 0.95,
    },
  } as unknown as EvaluationRun;
  assert.equal(evaluationMetrics(run).accuracy, "Incomplete");
  assert.equal(evaluationMetrics(run).awaitingAssessment, 1);
  run.summary.assessed = 20;
  run.summary.failed = 1;
  assert.equal(evaluationMetrics(run).accuracy, "95.0%");
});
test("saved answer replaces known citation markers only and preserves original text", () => {
  const text = "A fact [long-evidence-id:1]. Unknown [unregistered].";
  const answer = {
    text,
    sources: [{ id: "long-evidence-id:1" }],
  } as AnswerResult;
  assert.deepEqual(savedAnswerSegments(answer), [
    { text: "A fact " },
    { text: "[long-evidence-id:1]", id: "long-evidence-id:1" },
    { text: ". Unknown [unregistered]." },
  ]);
  assert.equal(answer.text, text);
});
