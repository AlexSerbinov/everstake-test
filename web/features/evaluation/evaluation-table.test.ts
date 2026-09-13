import { test } from "node:test";
import assert from "node:assert/strict";
import {
  failedRows,
  verdictLabel,
  qualityPercent,
} from "./evaluation-table.js";
import type { ResultRow } from "./question-result-card.js";

test("failure analysis distinguishes failed, pending and correct negative answers", () => {
  const rows: ResultRow[] = [
    { question: "Failure", answer: null, verdict: "fail" },
    { question: "Pending", answer: null, verdict: "pending" },
    {
      question: "Correct absence",
      answer: null,
      verdict: "correct_abstention",
    },
  ];
  assert.deepEqual(failedRows(rows), [rows[0]]);
  assert.equal(verdictLabel("pending"), "Ще не оцінено");
  assert.equal(verdictLabel("correct_abstention"), "Успішно");
  assert.equal(rows.length, 3);
});

test("quality percentage is explicit, bounded and independent of pass/fail", () => {
  const row: ResultRow = { question: "Example", answer: null, verdict: "fail" };
  assert.equal(qualityPercent(row), null);
  row.verdict = "pass";
  assert.equal(qualityPercent(row), null);
  row.verdict = "fail";
  row.qualityScore = {
    correctness: 40,
    completeness: 20,
    grounding: 20,
    uncertainty: 0,
    reason: "Missed a conflict",
  };
  assert.equal(qualityPercent(row), 80);
  row.qualityScore.correctness = 41;
  assert.equal(qualityPercent(row), null);
  row.qualityScore.correctness = NaN;
  assert.equal(qualityPercent(row), null);
  row.qualityScore = {
    correctness: 0,
    completeness: 0,
    grounding: 0,
    uncertainty: 0,
    reason: "No answer delivered",
  };
  assert.equal(qualityPercent(row), 0);
});
