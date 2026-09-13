import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import selection from "../../../config/evaluation-submission.json" with { type: "json" };
import { publicEvaluations } from "./current-evaluation.js";
import { averageQuality } from "./average-quality.js";
import type { EvaluationRun } from "./evaluation-page.js";
const read = (name: string) => JSON.parse(readFileSync(`artifacts/evaluation/${name}`, "utf8")) as EvaluationRun;
test("submission docs and UI agree with explicitly selected measured answers", () => {
  const runs = [read(selection.baseArtifact), ...selection.recheckArtifacts.map(read), read(selection.comparatorArtifact)];
  const current = publicEvaluations(runs)[0];
  assert.equal(current.viewKind, "updated");
  assert.equal(current.corpusVersion, selection.corpusVersion);
  assert.equal(current.summary.passed, 16);
  assert.equal(current.summary.failed, 4);
  assert.equal(current.summary.inventedFacts, 1);
  assert.equal(averageQuality(current), 92.75);
  for (const file of ["README.md", "README.uk.md", "REPORT.md", "REPORT.uk.md", "EVAL.md", "docs/DEFENCE.md", "docs/MCP_COMPARISON.md"]) {
    const text = readFileSync(file,"utf8").split("<!-- submission-summary:start -->")[1]?.split("<!-- submission-summary:end -->")[0];
    assert.ok(text?.includes(`${current.summary.passed}/20`), file);
    assert.ok(text?.replaceAll(",", ".").includes(`${averageQuality(current)}/100`), file);
  }
  const newer = { ...runs[0], id: "later-experiment", createdAt: "2099-01-01" };
  assert.equal(publicEvaluations([...runs,newer])[0].baseRunId, selection.baseRun);
});
