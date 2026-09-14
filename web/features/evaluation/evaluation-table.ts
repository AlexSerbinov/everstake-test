import { assessmentText } from "./assessment-translations.js";
import {
  evaluationText,
  type EvaluationLanguage,
} from "./evaluation-language.js";
import { badge, details, el } from "../../shared/dom.js";
import type { ResultRow } from "./question-result-card.js";
import { answerView } from "../ask/answer-view.js";

/** A rubric score is recorded separately; never infer it from a binary verdict. */
export function qualityPercent(row: ResultRow): number | null {
  const score = row.qualityScore;
  if (!score) return null;
  const limits = {
    correctness: 40,
    completeness: 30,
    grounding: 20,
    uncertainty: 10,
  };
  let total = 0;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = score[key];
    if (!Number.isFinite(value) || value < 0 || value > limits[key])
      return null;
    total += value;
  }
  return total;
}

export function verdictLabel(
  verdict: string,
  language: EvaluationLanguage = "en",
): string {
  const t = evaluationText(language);
  if (["pass", "correct", "correct_abstention"].includes(verdict))
    return t("Passed", "Успішно");
  if (["fail", "wrong", "false_abstention"].includes(verdict))
    return t("Failed", "Невдача");
  return t("Not assessed yet", "Ще не оцінено");
}
export function failedRows(rows: ResultRow[]): ResultRow[] {
  return rows.filter((row) =>
    ["fail", "wrong", "false_abstention"].includes(row.verdict),
  );
}
export function evaluationTable(
  rows: ResultRow[],
  runId: string,
  language: EvaluationLanguage = "en",
): HTMLElement {
  const t = evaluationText(language);
  const wrapper = el("div", "evaluation-table-wrap");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute(
    "aria-label",
    t("Answer evaluation table", "Таблиця оцінювання відповідей"),
  );
  const table = el("table", "evaluation-table");
  const header = el("tr");
  for (const title of [
    t("Question", "Питання"),
    t("Reference answer", "Очікувана відповідь"),
    t("System answer", "Відповідь системи"),
    t("Score and explanation", "Оцінка та пояснення"),
  ]) {
    const th = el("th", "", title);
    th.scope = "col";
    header.append(th);
  }
  const head = el("thead");
  head.append(header);
  table.append(head);
  const body = el("tbody");
  rows.forEach((row, index) => {
    const question =
      typeof row.question === "string"
        ? { id: String(index + 1), question: row.question, reference: "" }
        : row.question;
    const tr = el("tr");
    const q = el("td");
    q.append(badge(question.id), el("p", "", question.question));
    const reference = el("td");
    reference.append(
      el(
        "p",
        "",
        question.reference ||
          t(
            "No reference answer was saved.",
            "Еталонну відповідь не збережено.",
          ),
      ),
    );
    const actual = el("td");
    const answer =
      typeof row.answer === "string" ? row.answer : row.answer?.text;
    if (answer) {
      actual.append(
        el(
          "p",
          "evaluation-answer-preview",
          answer.replace(/\[[a-f0-9]{32,64}\]/g, "").slice(0, 200) +
            (answer.length > 200 ? "…" : ""),
        ),
      );
      actual.append(
        details(
          t(
            "Full answer, sources and checks",
            "Повна відповідь, джерела й перевірки",
          ),
          typeof row.answer === "string"
            ? el("p", "", row.answer)
            : answerView(row.answer!, `eval-${runId}-${index}`),
        ),
      );
    } else
      actual.append(
        el(
          "p",
          "muted",
          t(
            "No answer was saved in this run.",
            "Відповіді немає в цьому прогоні.",
          ),
        ),
      );
    const verdict = el("td");
    const percent = qualityPercent(row);
    verdict.append(
      el(
        "strong",
        "quality-score",
        percent === null
          ? t(
              "Percentage score not assigned yet",
              "Оцінка у % ще не виставлена",
            )
          : `${percent}%`,
      ),
    );
    if (percent !== null && row.qualityScore) {
      const score = row.qualityScore;
      verdict.append(
        details(
          t("How it was scored", "Як оцінено"),
          el(
            "p",
            "",
            t(
              `Factual correctness: ${score.correctness}/40. Completeness: ${score.completeness}/30. Source grounding: ${score.grounding}/20. Handling uncertainty: ${score.uncertainty}/10.`,
              `Правильність фактів: ${score.correctness}/40. Повнота: ${score.completeness}/30. Опора на джерела: ${score.grounding}/20. Робота з невизначеністю: ${score.uncertainty}/10.`,
            ),
          ),
          el("p", "", assessmentText(score.reason, language)),
        ),
      );
    }

    const label = verdictLabel(row.verdict, language);
    verdict.append(
      badge(
        label,
        label === t("Passed", "Успішно")
          ? "success"
          : label === t("Failed", "Невдача")
            ? "danger"
            : "warning",
      ),
      el(
        "p",
        "",
        assessmentText(row.explanation ?? "", language) ||
          t("Assessment is not complete yet.", "Оцінювання ще не завершене."),
      ),
    );
    if (row.inventedFacts === true)
      verdict.append(
        el(
          "p",
          "error-text",
          t(
            "Contains an unsupported factual claim.",
            "Є непідтверджене фактичне твердження.",
          ),
        ),
      );
    tr.append(q, reference, actual, verdict);
    body.append(tr);
  });
  table.append(body);
  wrapper.append(table);
  return wrapper;
}

export function failureBreakdown(
  rows: ResultRow[],
  language: EvaluationLanguage = "en",
): HTMLElement {
  const t = evaluationText(language);
  const section = el("section", "evaluation-failures");
  section.append(el("h2", "", t("Failure breakdown", "Розбір невдач")));
  const failures = failedRows(rows);
  if (!failures.length) {
    section.append(
      el(
        "p",
        "muted",
        rows.some(
          (row) =>
            verdictLabel(row.verdict, language) ===
            t("Not assessed yet", "Ще не оцінено"),
        )
          ? t(
              "Assessment is not complete. The absence of marked failures does not mean every answer is correct.",
              "Оцінювання ще не завершене. Відсутність позначених невдач не означає, що всі відповіді правильні.",
            )
          : t(
              "No failures were recorded among the assessed answers in this run. This does not guarantee other answers are correct.",
              "В оцінених відповідях цього прогону невдач не зафіксовано. Це не гарантує правильності інших відповідей.",
            ),
      ),
    );
    return section;
  }
  for (const row of failures) {
    const q =
      typeof row.question === "string"
        ? { id: "", question: row.question }
        : row.question;
    const entry = el("article", "evaluation-failure");
    entry.append(
      el("h3", "", `${q.id}: ${q.question}`),
      el(
        "p",
        "",
        assessmentText(row.explanation ?? "", language) ||
          t("No reason has been recorded yet.", "Причину ще не описано."),
      ),
    );
    if (
      row.answer &&
      typeof row.answer !== "string" &&
      row.answer.status === "error"
    )
      entry.append(
        el(
          "p",
          "muted small",
          t(
            "Technical request failure. This does not count as a correct abstention.",
            "Технічна помилка запиту. Не зараховується як правильне «не знаю».",
          ),
        ),
      );
    if (row.inventedFacts === true)
      entry.append(
        el(
          "p",
          "error-text",
          t(
            "The answer contains an unsupported fact.",
            "Відповідь містить непідтверджений факт.",
          ),
        ),
      );
    section.append(entry);
  }
  return section;
}
