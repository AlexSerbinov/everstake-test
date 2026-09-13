import { methodComparison } from "./method-comparison.js";
import {
  groupMetrics,
  selectResults,
  type QuestionGroup,
} from "./evaluation-groups.js";
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
  const page = el("section", "explore-page evaluation-page");
  page.append(
    el("p", "eyebrow", "MEASURED QUALITY"),
    el("h1", "", "Put every answer to the test."),
    el(
      "p",
      "lede",
      "Real questions. Saved answers. See what passed, what failed, and the evidence behind each result.",
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
            "Accuracy will appear after the question set is run and assessed.",
          ),
        );
        return;
      }
      const controls = el("div", "eval-run-controls");
      const label = el("label", "eyebrow", "Saved evaluation");
      const select = el("select");
      select.id = "evaluation-run";
      label.htmlFor = select.id;
      for (const run of runs) {
        const option = el(
          "option",
          "",
          `${date(run.createdAt)} · ${run.mode} · ${run.status} · ${run.id.slice(-8)}`,
        );
        option.value = run.id;
        select.append(option);
      }
      select.value = defaultEvaluationRun(runs)!.id;
      controls.append(
        label,
        select,
        el(
          "span",
          "muted small",
          "Viewing saved results does not start a new run.",
        ),
      );
      const overview = el("div");
      const groups = el("div", "eval-groups");
      const resultControls = el("div", "eval-result-controls");
      const count = el("p", "", "Question results");
      count.setAttribute("aria-live", "polite");
      const filterLabel = el("label", "", "Result");
      const filter = el("select");
      filter.id = "evaluation-filter";
      filterLabel.htmlFor = filter.id;
      for (const [value, text] of [
        ["all", "All results"],
        ["passed", "Passed"],
        ["failed", "Failed"],
        ["ungraded", "Not graded"],
        ["error", "Request errors"],
      ]) {
        const option = el("option", "", text);
        option.value = value;
        filter.append(option);
      }
      resultControls.append(count, filterLabel, filter);
      const list = el("div", "evaluation-list");
      let activeGroup: QuestionGroup = "all";
      const comparison = methodComparison(runs, (runId, questionIndex) => {
        select.value = runId;
        activeGroup = "all";
        filter.value = "all";
        render();
        if (questionIndex !== undefined) {
          const card = list.children[questionIndex] as
            HTMLDetailsElement | undefined;
          if (card) {
            card.open = true;
            const summary = card.querySelector("summary");
            summary?.focus({ preventScroll: true });
            card.scrollIntoView({ block: "start", behavior: "instant" });
          }
        } else controls.scrollIntoView({ block: "start", behavior: "instant" });
      });
      content.replaceChildren(
        comparison,
        controls,
        overview,
        groups,
        el(
          "p",
          "eval-subset-note",
          "Simple and hard describe difficulty. Negative cases are a subset of those questions: the correct response is to say the corpus has no reliable answer.",
        ),
        resultControls,
        list,
      );
      function render() {
        const run = runs.find((item) => item.id === select.value)!;
        const summary = run.summary;
        const progress = evaluationMetrics(run);
        const hero = el("div", "eval-score-panel");
        const score = el("div", "eval-score");
        score.append(
          el("p", "eyebrow", "Overall accuracy"),
          el(
            "strong",
            progress.assessmentComplete ? "" : "eval-score-status",
            progress.accuracy.replace(".0%", "%"),
          ),
          el(
            "p",
            "",
            `${summary.passed} passed out of ${progress.planned} planned questions`,
          ),
        );
        const outcomes = el("div", "eval-outcomes");
        outcomes.append(
          metric(
            "Passed",
            String(summary.passed),
            "Correct answers + correct abstentions",
          ),
          metric("Failed", String(summary.failed), "Includes partial answers"),
          metric(
            "Checked",
            `${summary.assessed} / ${progress.planned}`,
            "Grading progress, not the pass rate",
          ),
        );
        const bar = el("div", "eval-segments");
        bar.setAttribute("role", "img");
        bar.setAttribute(
          "aria-label",
          `${summary.passed} passed, ${summary.failed} failed, ${Math.max(0, progress.planned - summary.assessed)} not graded out of ${progress.planned} planned`,
        );
        for (let i = 0; i < progress.planned; i++)
          bar.append(
            el(
              "span",
              i < summary.passed
                ? "passed"
                : i < summary.passed + summary.failed
                  ? "failed"
                  : "pending",
            ),
          );
        const breakdown = el("div", "eval-score-breakdown");
        breakdown.append(
          outcomes,
          bar,
          el(
            "p",
            "small muted",
            `${summary.passed} passed · ${summary.failed} failed · ${progress.awaitingAssessment} awaiting grading · ${progress.notRun} not run`,
          ),
        );
        hero.append(score, breakdown);
        const extras = el("div", "eval-support-stats");
        extras.append(
          metric(
            "Answers with invented facts",
            summary.inventedFacts === null
              ? "Not established"
              : String(summary.inventedFacts),
            `Among ${summary.assessed} checked questions${progress.assessmentComplete ? "" : " · incomplete assessment"}`,
          ),
          metric(
            "Known evaluation cost",
            money(summary.knownCostUsd),
            summary.unknownCalls
              ? `${summary.unknownCalls} costs unconfirmed`
              : "Recorded usage",
          ),
          metric(
            "Request errors",
            String(progress.errors),
            "Provider errors are not abstentions",
          ),
        );
        overview.replaceChildren(
          hero,
          extras,
          el(
            "p",
            "eval-run-meta small muted",
            `${run.mode} · ${run.status} · Run ${run.id} · Collection ${run.corpusVersion}`,
          ),
        );
        groups.replaceChildren();
        for (const [group, title, description] of [
          ["all", "All questions", "The full saved question set"],
          ["simple", "Simple", "Direct facts and lookups"],
          ["hard", "Hard", "Conflicts, calculations and synthesis"],
          ["negative", "Negative cases", "Questions the corpus cannot answer"],
        ] as const) {
          const stats = groupMetrics(run.rows, group);
          const item = button(
            "",
            () => {
              activeGroup = group;
              render();
            },
            `eval-group ${group === activeGroup ? "active" : ""}`,
          );
          item.setAttribute("aria-pressed", String(group === activeGroup));
          item.append(
            el("span", "eval-group-title", title),
            el("strong", "", String(stats.total)),
            el(
              "span",
              "small",
              stats.accuracy === null
                ? `${stats.checked} / ${stats.total} checked · accuracy pending`
                : `${stats.passed} / ${stats.total} passed · ${(stats.accuracy * 100).toFixed(0)}%`,
            ),
            el("span", "muted small", description),
          );
          groups.append(item);
        }
        const rows = selectResults(run.rows, activeGroup, filter.value);
        count.textContent = `Question results · ${rows.length} shown of ${run.rows.length} saved`;
        list.replaceChildren(
          ...rows.map((row) =>
            questionResultCard(row, run.rows.indexOf(row), run.id),
          ),
        );
        if (!rows.length)
          list.append(
            empty(
              "No results in this filter",
              "Choose another group or result to see saved answers.",
            ),
          );
      }
      select.addEventListener("change", () => {
        activeGroup = "all";
        filter.value = "all";
        render();
      });
      filter.addEventListener("change", render);
      render();
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
