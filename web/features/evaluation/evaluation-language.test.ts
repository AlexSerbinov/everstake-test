import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { assessmentText } from "./assessment-translations.js";
import { evaluationText } from "./evaluation-language.js";
import { verdictLabel, failedRows } from "./evaluation-table.js";

test("language changes labels without changing failure classification", () => {
  assert.equal(evaluationText("en")("English", "Українська"), "English");
  assert.equal(evaluationText("uk")("English", "Українська"), "Українська");
  assert.equal(verdictLabel("fail", "en"), "Failed");
  assert.equal(verdictLabel("fail", "uk"), "Невдача");
  const rows = [{ question: "Question", answer: null, verdict: "fail" }];
  assert.deepEqual(failedRows(rows), rows);
});

test("all saved Ukrainian assessment notes have English display translations and retain their original text", () => {
  const directory = new URL("../../../artifacts/evaluation/", import.meta.url);
  let translated = 0;
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".json"),
  )) {
    const run = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
    const original = JSON.stringify(run);
    for (const row of run.rows ?? []) {
      for (const text of [row.explanation, row.qualityScore?.reason]) {
        if (typeof text !== "string" || !/[А-Яа-яІіЇїЄєҐґ]/u.test(text))
          continue;
        assert.doesNotMatch(
          assessmentText(text, "en"),
          /[А-Яа-яІіЇїЄєҐґ]/u,
          file,
        );
        assert.equal(assessmentText(text, "uk"), text);
        translated++;
      }
    }
    assert.equal(JSON.stringify(run), original);
  }
  assert.ok(translated > 0);
});

test("unrecognized or revised assessments keep their original wording", () => {
  const original = "A newly recorded review with different findings.";
  assert.equal(assessmentText(original, "en"), original);
  assert.equal(assessmentText(original, "uk"), original);
  const revised = "Технічний збій: нове пояснення.";
  assert.equal(assessmentText(revised, "en"), revised);
});
