import { averageQuality } from "../evaluation/average-quality.js";
import { el, getJson, metric, money } from "../../shared/dom.js";
import { publicEvaluations } from "../evaluation/current-evaluation.js";
import { defaultEvaluationRun } from "../evaluation/default-evaluation-run.js";
import { evaluationMetrics } from "../evaluation/evaluation-metrics.js";
import type { EvaluationRun } from "../evaluation/evaluation-page.js";

/** Summary values retain their separate current-corpus and saved-run scopes. */
export function collectionSummary(): HTMLElement {
  const rail = el("aside", "knowledge-rail");
  rail.setAttribute("aria-label", "Knowledge base statistics");
  rail.append(el("p", "eyebrow", "KNOWLEDGE BASE STATISTICS"));
  const corpus = metric("Collected documents", "Loading…");
  const quality = metric("Saved evaluation", "Loading…");
  const costs = metric("All-time known API cost", "Loading…");
  const refresh = el("div", "rail-note");
  refresh.append(
    el("p", "eyebrow", "SOURCE UPDATES"),
    el("p", "small muted", "Loading update status…"),
  );
  const limits = el("div", "rail-note");
  limits.append(
    el("p", "eyebrow", "WHAT THIS CANNOT DO"),
    el(
      "p",
      "small muted",
      "No private data or facts beyond the collected sources. If the evidence cannot support an answer, the assistant says so. A source’s checked date is not its fact date.",
    ),
  );
  rail.append(corpus, quality, costs, refresh, limits);
  void getJson<{ total: number; version: string }>("/api/corpus")
    .then((data) => {
      corpus.replaceWith(
        metric(
          "Collected documents",
          data.total.toLocaleString(),
          data.version,
        ),
      );
    })
    .catch(() => {
      corpus.replaceWith(metric("Collected documents", "Unavailable"));
    });
  void getJson<{ runs: EvaluationRun[] }>("/api/evaluations")
    .then(({ runs }) => {
      const visible = publicEvaluations(runs);
      const run = visible.find((run) => run.viewKind === "updated") ?? defaultEvaluationRun(visible);
      if (!run) {
        quality.replaceWith(metric("Saved evaluation", "Not measured"));
        return;
      }
      const progress = evaluationMetrics(run);
      const average = averageQuality(run);
      const result = metric(
        average === null ? "Saved evaluation" : "Evaluation · challenging questions",
        average === null ? "See results" : `${run.summary.passed}/${progress.planned} · ${average.toFixed(2)}/100`,
        average === null
          ? "See the saved answers and failure analysis in Evaluation."
          : `Post-hoc rubric review, including partial credit. ${run.summary.passed}/${progress.planned} fully passed${run.viewKind === "updated" ? ` after ${run.recheckedCount} rechecks; not a new full run` : ""}. Not a probability of correctness.`,
      );
      const link = el("a", "small", "Scores and failures →");
      link.href = "#evaluation";
      result.append(link);
      quality.replaceWith(result);
    })
    .catch(() => {
      quality.replaceWith(metric("Saved evaluation", "Unavailable"));
    });
  void getJson<{ knownCostUsd: number; unknownCalls: number }>("/api/costs")
    .then((data) => {
      costs.replaceWith(
        metric(
          "All-time known API cost",
          money(data.knownCostUsd),
          `${data.unknownCalls} unconfirmed charges. Includes collection, queries and evaluations.`,
        ),
      );
    })
    .catch(() => {
      costs.replaceWith(metric("Recorded API cost", "Unavailable"));
    });
  void getJson<{ settings: { automatic: boolean } }>("/api/updates")
    .then((data) => {
      refresh.replaceChildren(
        el("p", "eyebrow", "SOURCE UPDATES"),
        el(
          "p",
          "small muted",
          data.settings.automatic
            ? "Automatic checks are enabled. Each source follows its saved schedule."
            : "Automatic checks are off. An operator can refresh the collection in Updates.",
        ),
      );
    })
    .catch(() => {
      refresh.replaceChildren(
        el("p", "eyebrow", "SOURCE UPDATES"),
        el(
          "p",
          "small muted",
          "Update status unavailable. Check Updates for details.",
        ),
      );
    });
  return rail;
}
