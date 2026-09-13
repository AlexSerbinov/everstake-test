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
