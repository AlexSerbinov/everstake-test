import {
  badge,
  button,
  el,
  empty,
  getJson,
  metric,
  money,
} from "../../shared/dom.js";
import { defaultEvaluationRun } from "./default-evaluation-run.js";
import { evaluationMetrics } from "./evaluation-metrics.js";
import { date } from "../../shared/source-date.js";
import { questionResultCard, type ResultRow } from "./question-result-card.js";
export interface EvaluationRun {
  id: string;
  createdAt: string;
  corpusVersion: string;
  plannedTotal?: number;
  mode: string;
  status: string;
  rows: ResultRow[];
  summary: {
    total: number;
    completed?: number;
    assessed: number;
    passed: number;
    failed: number;
    accuracy: number | null;
    inventedFacts: number | null;
    knownCostUsd: number;
    unknownCalls: number;
  };
}
export function filterRows(rows: ResultRow[], verdict: string): ResultRow[] {
  return verdict === "all"
    ? rows
    : rows.filter((row) => row.verdict === verdict);
}
export function evaluationPage(): HTMLElement {
  const page = el("section", "explore-page");
  page.append(
    el("p", "eyebrow", "QUALITY, MADE VISIBLE"),
    el("h1", "", "Every answer is a test."),
    el(
      "p",
      "lede",
      "Explore saved evaluations: the questions, expected answers, actual results, and what went wrong. Opening this page does not run a new evaluation.",
    ),
  );
  const content = el("div");
  page.append(content);
  async function load() {
    content.replaceChildren(el("p", "muted", "Loading saved evaluations…"));
    try {
      const { runs } = await getJson<{ runs: EvaluationRun[] }>(
        "/api/evaluations",
      );
      if (!runs.length) {
        content.replaceChildren(
          empty(
            "No saved evaluation yet",
            "Results will appear here after the operator runs and assesses the question set. No accuracy claim is available yet.",
          ),
        );
        return;
      }
      const controls = el("div", "view-controls");
      const runLabel = el("label", "", "Saved run");
      const select = el("select");
      select.id = "evaluation-run";
      runLabel.htmlFor = select.id;
      for (const run of runs) {
        const option = el(
          "option",
          "",
          `${date(run.createdAt)} · ${run.mode} · ${run.status}`,
        );
        option.value = run.id;
        select.append(option);
      }
      select.value = defaultEvaluationRun(runs)!.id;
      const filterLabel = el("label", "", "Show results");
      const filter = el("select");
      filter.id = "evaluation-filter";
      filterLabel.htmlFor = filter.id;
      controls.append(runLabel, select, filterLabel, filter);
      const overview = el("div");
      const list = el("div", "evaluation-list");
      content.replaceChildren(controls, overview, list);
      function render(resetFilter = false) {
        const run = runs.find((item) => item.id === select.value)!;
        const summary = run.summary;
        const progress = evaluationMetrics(run);
        if (resetFilter) {
          filter.replaceChildren();
          for (const value of [
            "all",
            ...new Set(run.rows.map((row) => row.verdict || "ungraded")),
          ]) {
            const option = el(
              "option",
              "",
              value === "all" ? "All results" : value.replaceAll("_", " "),
            );
            option.value = value;
            filter.append(option);
          }
        }
        const stats = el("div", "metrics");
        stats.append(
          metric(
            "Strict accuracy",
            progress.accuracy,
            `${summary.passed} passed / ${progress.planned} planned`,
          ),
          metric(
            "Assessed",
            `${summary.assessed} / ${progress.planned}`,
            `${summary.failed} failed · ${progress.awaitingAssessment} awaiting assessment · ${progress.notRun} not run`,
          ),
          metric(
            "Answers with invented facts",
            summary.inventedFacts === null
              ? "Not established"
              : String(summary.inventedFacts),
            `Among ${summary.assessed} assessed questions`,
          ),
          metric(
            "Known run cost",
            money(summary.knownCostUsd),
            summary.unknownCalls
              ? `${summary.unknownCalls} costs unconfirmed`
              : "Recorded usage",
          ),
        );
        const version = el(
          "p",
          "muted small",
          `Run ${run.id} · Collection ${run.corpusVersion} · ${run.mode}`,
        );
        const state = badge(
          run.status === "completed" && !progress.assessmentComplete
            ? "Answers saved · assessment incomplete"
            : run.status,
          run.status === "completed" && progress.assessmentComplete
            ? ""
            : "warning",
        );
        overview.replaceChildren(
          stats,
          version,
          state,
          el(
            "p",
            "muted small",
            `${progress.completed} requests recorded · ${progress.errors} request errors · ${progress.notRun} planned questions have no saved answer in this run.`,
          ),
          el(
            "p",
            "muted small",
            "Partial answers do not count as strict successes. Filters below do not change the overall results. An incomplete assessment cannot establish zero invented facts.",
          ),
        );
        list.replaceChildren();
        const rows = filterRows(run.rows, filter.value);
        rows.forEach((row) =>
          list.append(questionResultCard(row, run.rows.indexOf(row), run.id)),
        );
        if (!rows.length)
          list.append(
            empty(
              "No results in this filter",
              "Choose another verdict to see saved answers.",
            ),
          );
      }
      select.addEventListener("change", () => render(true));
      filter.addEventListener("change", () => render());
      render(true);
    } catch (error) {
      content.replaceChildren(
        empty("Evaluations unavailable", (error as Error).message),
        button("Try again", () => void load()),
      );
    }
  }
  void load();
  return page;
}
