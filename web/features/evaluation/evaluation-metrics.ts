import type { EvaluationRun } from "./evaluation-page.js";

/** Present the saved assessment without calculating a verdict or filling missing results. */
export function evaluationMetrics(run: EvaluationRun) {
  const planned = run.plannedTotal ?? run.summary.total;
  const completed = run.summary.completed ?? run.rows.length;
  const assessed = run.summary.assessed;
  return {
    planned,
    completed,
    notRun: Math.max(0, planned - completed),
    awaitingAssessment: Math.max(0, completed - assessed),
    errors: run.rows.filter(
      (row) =>
        row.answer &&
        typeof row.answer !== "string" &&
        row.answer.status === "error",
    ).length,
    accuracy:
      run.summary.accuracy === null
        ? assessed
          ? "Incomplete"
          : "Not assessed"
        : `${(run.summary.accuracy * 100).toFixed(1)}%`,
    assessmentComplete: planned > 0 && assessed === planned,
  };
}
