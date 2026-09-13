import type { EvaluationRun } from "./evaluation-page.js";
import { qualityPercent } from "./evaluation-table.js";

/** Only summarize a complete set of recorded rubric scores, never infer missing grades. */
export function averageQuality(run: EvaluationRun): number | null {
  if (!run.rows.length || run.rows.length !== (run.plannedTotal ?? run.summary.total))
    return null;
  const scores = run.rows.map(qualityPercent);
  if (scores.some((score) => score === null)) return null;
  return (scores as number[]).reduce((sum, score) => sum + score, 0) / scores.length;
}
