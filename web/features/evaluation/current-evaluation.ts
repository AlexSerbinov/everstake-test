import type { EvaluationRun } from "./evaluation-page.js";
import { defaultEvaluationRun } from "./default-evaluation-run.js";

/** A labelled presentation of latest assessed answers; saved runs remain unchanged. */
export function publicEvaluations(saved: EvaluationRun[]): EvaluationRun[] {
  const visible = saved.filter((run) => run.mode !== "baseline");
  const base = defaultEvaluationRun(visible.filter((run) => !run.recheckOf));
  if (!base || base.summary.assessed !== 20 || base.rows.length !== 20)
    return visible;
  const key = (row: EvaluationRun["rows"][number]) =>
    typeof row.question === "string" ? row.question : row.question.id;
  const text = (row: EvaluationRun["rows"][number]) =>
    typeof row.question === "string" ? row.question : row.question.question;
  const originals = new Map(base.rows.map((row) => [key(row), row]));
  const rechecks = visible
    .filter(
      (run) =>
        run.recheckOf === base.id &&
        run.status === "completed" &&
        run.rows.length > 0 &&
        run.summary.assessed === run.rows.length &&
        run.rows.length === (run.plannedTotal ?? run.summary.total) &&
        run.corpusVersion === base.corpusVersion &&
        run.questionSetVersion === base.questionSetVersion &&
        run.createdAt >= base.createdAt &&
        new Set(run.rows.map(key)).size === run.rows.length &&
        run.rows.every(
          (row) =>
            originals.has(key(row)) &&
            text(originals.get(key(row))!) === text(row) &&
            ["pass", "fail"].includes(row.verdict),
        ),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!rechecks.length) return visible;
  const latest = new Map(originals);
  const changed = new Set<string>();
  for (const run of rechecks)
    for (const row of run.rows) {
      latest.set(key(row), row);
      changed.add(key(row));
    }
  const rows = base.rows.map((row) => latest.get(key(row))!);
  const passed = rows.filter((row) => row.verdict === "pass").length;
  const summary = {
    ...base.summary,
    passed,
    failed: rows.length - passed,
    accuracy: passed / rows.length,
    inventedFacts: rows.some((row) => row.inventedFacts == null)
      ? null
      : rows.filter((row) =>
          Array.isArray(row.inventedFacts)
            ? row.inventedFacts.length > 0
            : Boolean(row.inventedFacts),
        ).length,
    knownCostUsd: [base, ...rechecks].reduce(
      (sum, run) => sum + run.summary.knownCostUsd,
      0,
    ),
    unknownCalls: [base, ...rechecks].reduce(
      (sum, run) => sum + run.summary.unknownCalls,
      0,
    ),
  };
  const current: EvaluationRun = {
    ...base,
    id: `${base.id}-updated-view`,
    createdAt: rechecks.at(-1)!.createdAt,
    rows,
    summary,
    viewKind: "updated",
    baseRunId: base.id,
    recheckedCount: changed.size,
    sourceRunIds: [base.id, ...rechecks.map((run) => run.id)],
  };
  return [current, ...visible];
}
