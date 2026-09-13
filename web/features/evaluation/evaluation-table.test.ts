import { test } from "node:test";
import assert from "node:assert/strict";
import { failedRows, verdictLabel } from "./evaluation-table.js";
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
