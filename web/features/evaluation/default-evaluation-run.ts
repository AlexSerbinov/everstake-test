import type { EvaluationRun } from "./evaluation-page.js";

/** The assignment's full set has 20 cases. Prefer recency, never the highest score. */
export function defaultEvaluationRun(
  runs: EvaluationRun[],
): EvaluationRun | undefined {
  const newestFirst = [...runs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const fullAssessment = (run: EvaluationRun) =>
    run.status === "completed" &&
    (run.plannedTotal ?? run.summary.total) === 20 &&
    (run.summary.completed ?? run.rows.length) === 20 &&
    run.summary.assessed === 20 &&
    run.summary.accuracy !== null;
  return (
    newestFirst.find((run) => run.mode === "agent" && fullAssessment(run)) ??
    newestFirst.find(fullAssessment) ??
    newestFirst[0]
  );
}
