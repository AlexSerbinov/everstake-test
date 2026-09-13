import { badge, button, details, el, money } from "../../shared/dom.js";
import { date } from "../../shared/source-date.js";
import { evaluationMetrics } from "./evaluation-metrics.js";
import { groupMetrics, resultState } from "./evaluation-groups.js";
import type { EvaluationRun } from "./evaluation-page.js";
import type { ResultRow } from "./question-result-card.js";
export const comparisonMethods = ["agent", "baseline", "mcp"] as const;
export type ComparisonMethod = (typeof comparisonMethods)[number];
const names = {
  agent: "Knowledge assistant",
  baseline: "Retrieval baseline",
  mcp: "Official MCP + Gemini",
};
export function questionKey(row: ResultRow): string {
  return typeof row.question === "string"
    ? row.question.trim()
    : `${row.question.id}\n${row.question.question.trim()}`;
}
function questionSet(run: EvaluationRun): string | null {
  if (
    run.status !== "completed" ||
    (run.plannedTotal ?? run.summary.total) !== 20 ||
    run.rows.length !== 20
  )
    return null;
  const keys = run.rows.map(questionKey);
  if (new Set(keys).size !== 20) return null;
  return JSON.stringify(keys.sort());
}
/** Compare the newest full saved runs for the exact same questions, never the highest scores. */
export function comparableRuns(
  runs: EvaluationRun[],
): Partial<Record<ComparisonMethod, EvaluationRun>> {
  const sorted = [...runs].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const anchor =
    sorted.find((run) => run.mode === "agent" && questionSet(run)) ??
    sorted.find((run) => questionSet(run));
  if (!anchor) return {};
  const key = questionSet(anchor);
  return Object.fromEntries(
    comparisonMethods
      .map((method) => [
        method,
        sorted.find((run) => run.mode === method && questionSet(run) === key),
      ])
      .filter(([, run]) => run),
  );
}
function referencesMatch(a: EvaluationRun, b: EvaluationRun): boolean {
  return a.rows.every((row) => {
    const other = b.rows.find(
      (candidate) => questionKey(candidate) === questionKey(row),
    );
    return (
      other &&
      typeof row.question !== "string" &&
      typeof other.question !== "string" &&
      row.question.reference === other.question.reference &&
      JSON.stringify(row.question.rubric) ===
        JSON.stringify(other.question.rubric)
    );
  });
}
function labeled(label: string, value: string): HTMLElement {
  const row = el("div", "method-stat");
  row.append(el("span", "", label), el("strong", "", value));
  return row;
}
export function methodComparison(
  runs: EvaluationRun[],
  choose: (runId: string, questionIndex?: number) => void,
): HTMLElement {
  const selected = comparableRuns(runs);
  const section = el("section", "method-comparison");
  section.append(
    el("p", "eyebrow", "SAME QUESTIONS, DIFFERENT APPROACHES"),
    el("h2", "", "How the methods compare"),
    el(
      "p",
      "method-intro",
      "The latest complete 20-question run for each method, matched by question ID and text. A saved response is not a passing grade.",
    ),
  );
  const columns = el("div", "method-columns");
  for (const method of comparisonMethods) {
    const card = el("article", `method-column method-${method}`);
    card.append(el("h3", "", names[method]));
    const run = selected[method];
    if (!run) {
      card.append(
        el("p", "method-no-score", "Not available"),
        el(
          "p",
          "small muted",
          "No complete saved run with the same 20 questions. No score is claimed.",
        ),
      );
      columns.append(card);
      continue;
    }
    const progress = evaluationMetrics(run);
    card.append(
      el("strong", "method-score", progress.accuracy.replace(".0%", "%")),
      el(
        "p",
        "small",
        `${run.summary.passed} passed · ${run.summary.failed} failed · ${run.summary.assessed} / 20 checked`,
      ),
    );
    for (const [group, label] of [
      ["simple", "Simple"],
      ["hard", "Hard"],
      ["negative", "Negative cases¹"],
    ] as const) {
      const stats = groupMetrics(run.rows, group);
      card.append(
        labeled(
          label,
          stats.accuracy === null
            ? `${stats.checked}/${stats.total} graded`
            : `${stats.passed}/${stats.total} · ${(stats.accuracy * 100).toFixed(0)}%`,
        ),
      );
    }
    card.append(
      labeled(
        "Invented-fact cases",
        run.summary.inventedFacts === null
          ? "Not established"
          : `${run.summary.inventedFacts}${progress.assessmentComplete ? "" : " (partial review)"}`,
      ),
      labeled("Request errors", String(progress.errors)),
      labeled("Known run cost", money(run.summary.knownCostUsd)),
    );
    if (run.summary.unknownCalls)
      card.append(
        el(
          "p",
          "small muted",
          `${run.summary.unknownCalls} call costs unconfirmed`,
        ),
      );
    card.append(
      el("p", "method-date small muted", `Run: ${date(run.createdAt)}`),
      el("p", "method-snapshot small muted", `Evidence: ${run.corpusVersion}`),
    );
    const metadata = run as EvaluationRun & {
      comparison?: {
        model?: string;
        provenance?: { capturedAt?: string };
        methodology?: string;
      };
      manifest?: { models?: { answer?: string } };
    };
    if (metadata.comparison?.provenance?.capturedAt)
      card.append(
        el(
          "p",
          "small muted",
          `MCP captured: ${date(metadata.comparison.provenance.capturedAt)}`,
        ),
      );
    if (metadata.comparison?.model)
      card.append(
        el("p", "small muted", `Answer model: ${metadata.comparison.model}`),
      );
    card.append(
      button("Inspect this run →", () => choose(run.id), "method-inspect"),
    );
    columns.append(card);
  }
  section.append(
    columns,
    el(
      "p",
      "method-footnote",
      "¹ Negative cases are a subset of the simple/hard questions, not extra questions. Accuracy includes correct abstentions; partial answers fail strict grading.",
    ),
  );
  const caveats = el("div", "method-caveats");
  caveats.append(
    el(
      "p",
      "",
      "Knowledge assistant: searches the crawled collection, selects evidence, checks claims and records costs. Retrieval baseline: a single answer-generation turn over retrieved passages.",
    ),
    el(
      "p",
      "",
      "Official MCP + Gemini: the official MCP server supplies tool data; Gemini writes the answers from captured MCP responses only. MCP itself is not a language model. This is a single-turn context comparison, not an autonomous MCP agent. The unrelated calculator probe is not supplied as evidence.",
    ),
    el(
      "p",
      "",
      "These questions were designed around the frozen web corpus, including historical changes and conflicting documents. That scope favors the knowledge assistant and does not measure MCP’s live uptime, chain data or staking calculator capabilities. This score is not an overall ranking of the products.",
    ),
    el(
      "p",
      "",
      "Evidence dates and data coverage differ. Run costs cover the recorded answer calls, not equal infrastructure or collection costs. Factual correctness and invented facts are independently graded; ungraded runs have no accuracy claim.",
    ),
  );
  const anchor = selected.agent ?? selected.baseline ?? selected.mcp;
  if (
    anchor &&
    Object.values(selected).some((run) => !referencesMatch(anchor, run))
  )
    caveats.append(
      el(
        "p",
        "method-reference-warning",
        "Reference answers or rubrics differ between these saved runs. The questions match, but grading conditions changed; these scores are not a controlled head-to-head benchmark.",
      ),
    );
  section.append(details("Method and comparison limits", caveats));
  if (anchor) {
    const table = el("div", "method-question-list");
    for (const [index, row] of anchor.rows.entries()) {
      const item = el("div", "method-question");
      item.append(
        el(
          "p",
          "",
          `${String(index + 1).padStart(2, "0")} · ${typeof row.question === "string" ? row.question : row.question.question}`,
        ),
      );
      const scores = el("div", "method-question-scores");
      for (const method of comparisonMethods) {
        const run = selected[method];
        const rowIndex =
          run?.rows.findIndex(
            (candidate) => questionKey(candidate) === questionKey(row),
          ) ?? -1;
        if (!run || rowIndex < 0) {
          scores.append(
            el("span", "small muted", `${names[method]}: unavailable`),
          );
          continue;
        }
        const state = resultState(run.rows[rowIndex]);
        const stateName =
          state === "ungraded"
            ? "Not graded"
            : state === "passed"
              ? "Passed"
              : state === "failed"
                ? "Failed"
                : "Request error";
        const inspect = button(
          "",
          () => choose(run.id, rowIndex),
          "method-question-button",
        );
        inspect.setAttribute(
          "aria-label",
          `${names[method]}: ${stateName}. Read answer to question ${index + 1}`,
        );
        inspect.append(
          el("span", "", names[method]),
          badge(
            stateName,
            state === "passed"
              ? "success"
              : state === "failed" || state === "error"
                ? "danger"
                : "warning",
          ),
        );
        scores.append(inspect);
      }
      item.append(scores);
      table.append(item);
    }
    section.append(details("Compare all 20 questions side by side", table));
  }
  return section;
}
