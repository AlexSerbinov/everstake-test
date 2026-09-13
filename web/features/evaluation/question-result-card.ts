import type {
  AnswerResult,
  EvaluationQuestion,
} from "../../../src/contracts.js";
import { badge, details, el } from "../../shared/dom.js";
import { answerView } from "../answer/answer-view.js";
export interface ResultRow {
  question: EvaluationQuestion | string;
  answer: AnswerResult | string | null;
  verdict: string;
  inventedFacts?: unknown[] | number | boolean | null;
  explanation?: string;
}
export function questionResultCard(
  row: ResultRow,
  index: number,
  runId: string,
): HTMLElement {
  const question =
    typeof row.question === "string"
      ? {
          id: `${index + 1}`,
          question: row.question,
          whyHard: "",
          category: "",
          reference: "",
          rubric: [],
        }
      : row.question;
  const verdict = row.verdict || "ungraded";
  const card = el("article", "evaluation-card");
  const meta = el("div", "answer-meta");
  meta.append(
    badge(question.id),
    badge(
      verdict.replaceAll("_", " "),
      ["correct", "correct_abstention", "pass"].includes(verdict)
        ? "success"
        : ["wrong", "false_abstention", "fail"].includes(verdict)
          ? "danger"
          : "warning",
    ),
  );
  if (question.category) meta.append(badge(question.category));
  card.append(
    meta,
    el("h3", "", question.question),
    el(
      "p",
      "difficulty-note",
      `Why this is challenging: ${question.whyHard || "No difficulty explanation was recorded."}`,
    ),
  );
  const body = el("div");
  const comparison = el("div", "comparison");
  const expected = el("div");
  expected.append(
    el("h4", "", "Expected answer"),
    el("p", "", question.reference || "No reference answer was published."),
  );
  const actual = el("div");
  actual.append(
    el("h4", "", "System answer"),
    el(
      "p",
      "",
      typeof row.answer === "string"
        ? row.answer
        : row.answer?.text || "This question has no saved answer.",
    ),
  );
  comparison.append(expected, actual);
  body.append(comparison);
  if (question.rubric?.length) {
    const rubric = el("ul");
    question.rubric.forEach((rule) => rubric.append(el("li", "", rule)));
    body.append(details("What this question tests", rubric));
  }
  body.append(
    el("h4", "", "Why this verdict"),
    el(
      "p",
      "muted",
      row.explanation || "No assessment explanation was recorded.",
    ),
  );
  const inventions = Array.isArray(row.inventedFacts)
    ? row.inventedFacts.length
    : typeof row.inventedFacts === "boolean"
      ? Number(row.inventedFacts)
      : row.inventedFacts;
  if (inventions === null || inventions === undefined)
    body.append(
      el(
        "p",
        "muted small",
        "Invented facts have not been independently assessed for this answer.",
      ),
    );
  if (inventions)
    body.append(
      el(
        "p",
        "error-text",
        `${inventions} invented fact${inventions === 1 ? "" : "s"} identified in this answer.`,
      ),
    );
  if (row.answer && typeof row.answer !== "string")
    body.append(
      details(
        "Sources, checks and answer receipt",
        answerView(row.answer, `eval-${runId}-${index}`),
      ),
    );
  card.append(details("Compare answers and read the assessment", body));
  return card;
}
