import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { openDatabase } from "../src/storage/database.js";
import {
  saveEvaluation,
  type EvaluationRun,
} from "../src/services/evaluation/run-evaluation.js";
const gradesSchema = z.array(
  z.object({
    runId: z.string(),
    rows: z
      .array(
        z.object({
          id: z.string(),
          verdict: z.enum(["pass", "fail"]),
          inventedFacts: z.boolean(),
          explanation: z.string().min(10),
        }),
      )
      .length(20),
  }),
);
const input = process.argv[2];
if (!input) throw new Error("Provide independently reviewed grades JSON");
const grades = gradesSchema.parse(JSON.parse(readFileSync(input, "utf8")));
const db = openDatabase();
const runs: EvaluationRun[] = [];
try {
  for (const grade of grades) {
    const row = db
      .prepare("SELECT result FROM evaluations WHERE id=?")
      .get(grade.runId);
    if (!row) throw new Error("Evaluation run not found");
    const run = JSON.parse(String(row.result)) as EvaluationRun;
    if (
      run.rows.length !== 20 ||
      new Set(grade.rows.map((r) => r.id)).size !== 20
    )
      throw new Error("All twenty distinct cases must be assessed");
    for (const result of run.rows) {
      const assessed = grade.rows.find((r) => r.id === result.question.id);
      if (!assessed) throw new Error("Missing grade");
      Object.assign(result, {
        verdict: assessed.verdict,
        inventedFacts: assessed.inventedFacts,
        explanation: assessed.explanation,
      });
    }
    saveEvaluation(db, run);
    runs.push(run);
  }
  const agent = runs.filter((r) => r.mode === "agent").at(-1);
  const baseline = runs.filter((r) => r.mode === "baseline").at(-1);
  if (!agent || !baseline || agent.corpusVersion !== baseline.corpusVersion)
    throw new Error("Provide comparable agent and baseline runs");
  const answerText = (row: EvaluationRun["rows"][number]) =>
    row.answer.sources.reduce(
      (text, source, index) =>
        text.replaceAll(`[${source.id}]`, `[${index + 1}](${source.url})`),
      row.answer.text,
    );
  const cell = (value: string) =>
    value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
  let markdown = `# Measured evaluation\n\nTwenty fixed questions: five basic and fifteen hard, including five negative cases. References were audited against the frozen corpus; the runtime never reads them.\n\nCorpus: \`${agent.corpusVersion}\`. Agent run: \`${agent.id}\`; baseline: \`${baseline.id}\`. Full responses, cited passages and receipts are in [artifacts/evaluation](artifacts/evaluation/).\n\n| Mode | Passed | Failed | Accuracy | Cases with invented facts | Known cost | Unknown calls |\n|---|---:|---:|---:|---:|---:|---:|\n`;
  for (const run of [agent, baseline])
    markdown += `| ${run.mode} | ${run.summary.passed}/20 | ${run.summary.failed} | ${((run.summary.accuracy ?? 0) * 100).toFixed(0)}% | ${run.summary.inventedFacts} | $${run.summary.knownCostUsd.toFixed(6)} | ${run.summary.unknownCalls} |\n`;
  markdown +=
    "\nAccuracy counts all twenty questions, including infrastructure errors and partial answers that omit a requested conclusion. “Invented facts” counts cases containing an unsupported factual assertion, separately from other failures. A safe omission can fail completeness without inventing a fact. Review is an independent coding-agent rubric audit, not human-certified ground truth.\n\nThe plain-RAG baseline receives six initial passages and one answer turn, with the same citation/support gates. The agent can search/read/calculate within bounded steps. This measures the benefit of research actions on the same corpus and models, not a comparison with Everstake MCP or an ungated LLM.\n\n## All twenty agent answers\n\n| ID / Question | Reference answer | System answer | Verdict / explanation |\n|---|---|---|---|\n";
  for (const row of agent.rows)
    markdown += `| ${row.question.id}: ${cell(row.question.question)} | ${cell(row.question.reference)} | ${cell(answerText(row))} | **${row.verdict.toUpperCase()}** — ${cell(row.explanation)}${row.inventedFacts ? " **Contains an invented fact.**" : ""} |\n`;
  markdown += "\n## Failure breakdown and baseline differences\n\n";
  for (const row of agent.rows.filter((r) => r.verdict === "fail"))
    markdown += `- **${row.question.id}** (${row.answer.status}): ${row.explanation}\n`;
  markdown +=
    "\n| Case | Agent | Baseline | Baseline explanation |\n|---|---|---|---|\n";
  for (const row of baseline.rows)
    markdown += `| ${row.question.id} | ${agent.rows.find((r) => r.question.id === row.question.id)!.verdict} | ${row.verdict} | ${cell(row.explanation)} |\n`;
  const earlier = db
    .prepare("SELECT result FROM evaluations ORDER BY created_at")
    .all()
    .map((r) => JSON.parse(String(r.result)) as EvaluationRun)
    .filter(
      (r) =>
        r.mode === "agent" &&
        r.id !== agent.id &&
        r.status === "completed" &&
        r.summary.accuracy !== null,
    )
    .map(
      (r) =>
        `\`${r.id}\` ${r.summary.passed}/20 (${((r.summary.accuracy ?? 0) * 100).toFixed(0)}%, ${r.summary.inventedFacts} unsupported-fact case${r.summary.inventedFacts === 1 ? "" : "s"})`,
    );
  markdown += `\nEarlier complete agent runs on the same corpus are retained as measured iterations, alongside incomplete diagnostic runs: ${earlier.join("; ")}. No answers are stitched into any run. Model-based support verification is fallible; deterministic citation and arithmetic checks do not prove semantic truth.\n`;
  writeFileSync("EVAL.md", markdown);
  console.log(
    JSON.stringify(runs.map((r) => ({ id: r.id, summary: r.summary }))),
  );
} finally {
  db.close();
}
