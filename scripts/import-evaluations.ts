import { readdirSync, readFileSync } from "node:fs";
import { openDatabase } from "../src/storage/database.js";
import type { EvaluationRun } from "../src/services/evaluation/run-evaluation.js";
// Graded evaluation runs are produced on the operator's machine and published as
// artifacts; the demo host imports them so its Evaluation screen shows the same
// runs without re-running paid questions. Rows already present are replaced.
const db = openDatabase();
try {
  let imported = 0;
  for (const file of readdirSync("artifacts/evaluation")) {
    if (!file.endsWith(".json")) continue;
    const run = JSON.parse(
      readFileSync(`artifacts/evaluation/${file}`, "utf8"),
    ) as EvaluationRun;
    if (run.plannedTotal !== 20 || run.rows.length !== 20) continue;
    db.prepare(
      "INSERT OR REPLACE INTO evaluations(id,created_at,result) VALUES(?,?,?)",
    ).run(run.id, run.createdAt, JSON.stringify(run));
    imported++;
  }
  console.log(JSON.stringify({ imported }));
} finally {
  db.close();
}
