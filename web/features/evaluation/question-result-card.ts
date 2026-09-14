import type {
  AnswerResult,
  EvaluationQuestion,
} from "../../../src/contracts.js";
import { badge, details, el, link } from "../../shared/dom.js";
import { answerView } from "../ask/answer-view.js";
import { citationSegments } from "../ask/citation-navigation.js";
import { resultState } from "./evaluation-groups.js";
export interface ResultRow {
  question: EvaluationQuestion | string;
  answer: AnswerResult | string | null;
  verdict: string;
  inventedFacts?: unknown[] | number | boolean | null;
  explanation?: string;
  qualityScore?: { correctness: number; completeness: number; grounding: number; uncertainty: number; reason: string };
}
/** Replace only registered evidence markers; never alter the saved answer or guess links. */
export function savedAnswerSegments(answer: AnswerResult) {
  return citationSegments(
    answer.text,
    answer.sources.map((source) => source.id),
  );
}
function savedAnswer(row: ResultRow): HTMLElement {
  const body = el("div", "eval-answer-text");
  if (!row.answer || typeof row.answer === "string") {
    body.textContent = row.answer || "This question has no saved answer.";
    return body;
  }
  const answer = row.answer;
  for (const segment of savedAnswerSegments(answer)) {
    if (!segment.id) body.append(document.createTextNode(segment.text));
    else {
      const index = answer.sources.findIndex(
        (source) => source.id === segment.id,
      );
      const source = answer.sources[index];
      const citation = link(`[${index + 1}]`, source.url);
      citation.className = "eval-citation";
      citation.setAttribute(
        "aria-label",
        `Source ${index + 1}: ${source.title}`,
      );
      citation.title = source.title;
      body.append(citation);
    }
  }
  return body;
}
export function questionResultCard(
  row: ResultRow,
  index: number,
  runId: string,
): HTMLElement {
  const question = typeof row.question === "string" ? null : row.question;
  const state = resultState(row);
  const card = el("details", `evaluation-card eval-result ${state}`);
  const summary = el("summary", "eval-result-summary");
  const number = el(
    "span",
    "eval-question-number",
    String(index + 1).padStart(2, "0"),
  );
  const heading = el("span", "eval-question-heading");
  heading.append(
    el(
      "span",
      "eval-question-text",
      question?.question ?? String(row.question),
    ),
  );
  const meta = el("span", "eval-question-meta");
  if (question?.difficulty)
    meta.append(
      el("span", "", question.difficulty === "basic" ? "Simple" : "Hard"),
    );
  if (question?.negative) meta.append(el("span", "", "Negative case"));
  heading.append(meta);
  summary.append(
    number,
    heading,
    badge(
      state === "ungraded"
        ? "Not graded"
        : state === "error"
          ? "Request error"
          : state === "passed"
            ? "Passed"
            : "Failed",
      state === "passed"
        ? "success"
        : state === "failed" || state === "error"
          ? "danger"
          : "warning",
    ),
    el("span", "eval-expand", "+"),
  );
  const body = el("div", "eval-result-body");
  const comparison = el("div", "eval-comparison");
  const expected = el("section");
  expected.append(
    el("h3", "eyebrow", "Expected answer"),
    el("p", "", question?.reference || "No reference answer was published."),
  );
  const actual = el("section");
  actual.append(el("h3", "eyebrow", "System answer"), savedAnswer(row));
  comparison.append(expected, actual);
  body.append(
    comparison,
    el("h3", "eyebrow", "Assessment"),
    el(
      "p",
      "",
      `${(row.verdict || "ungraded").replaceAll("_", " ")} · ${row.explanation || "No assessment explanation was recorded."}`,
    ),
  );
  if (question?.whyHard) body.append(el("p", "muted small", question.whyHard));
  const inventions = Array.isArray(row.inventedFacts)
    ? row.inventedFacts.length
    : row.inventedFacts;
  body.append(
    el(
      "p",
      "small",
      inventions === null || inventions === undefined
        ? "Invented facts: not independently assessed."
        : inventions === true
          ? "Invented facts identified; exact count not recorded."
          : `Invented facts identified: ${inventions === false ? 0 : inventions}.`,
    ),
  );
  if (question?.rubric?.length) {
    const rubric = el("ul");
    question.rubric.forEach((rule) => rubric.append(el("li", "", rule)));
    body.append(details("What this question tests", rubric));
  }
  if (row.answer && typeof row.answer !== "string")
    body.append(
      details(
        "Evidence, checks and cost",
        answerView(row.answer, `eval-${runId}-${index}`),
      ),
    );
  card.append(summary, body);
  return card;
}
