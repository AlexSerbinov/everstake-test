import { badge, details, el } from "../../shared/dom.js";
import type { ResultRow } from "./question-result-card.js";
import { answerView } from "../answer/answer-view.js";

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

export function verdictLabel(verdict: string): string {
  if (["pass", "correct", "correct_abstention"].includes(verdict))
    return "Успішно";
  if (["fail", "wrong", "false_abstention"].includes(verdict)) return "Невдача";
  return "Ще не оцінено";
}
export function failedRows(rows: ResultRow[]): ResultRow[] {
  return rows.filter((row) => verdictLabel(row.verdict) === "Невдача");
}
export function evaluationTable(rows: ResultRow[], runId: string): HTMLElement {
  const wrapper = el("div", "evaluation-table-wrap");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", "Таблиця оцінювання відповідей");
  const table = el("table", "evaluation-table");
  const header = el("tr");
  for (const title of [
    "Питання",
    "Очікувана відповідь",
    "Відповідь системи",
    "Оцінка та пояснення",
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
      el("p", "", question.reference || "Еталонну відповідь не збережено."),
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
          "Повна відповідь, джерела й перевірки",
          typeof row.answer === "string"
            ? el("p", "", row.answer)
            : answerView(row.answer!, `eval-${runId}-${index}`),
        ),
      );
    } else actual.append(el("p", "muted", "Відповіді немає в цьому прогоні."));
    const verdict = el("td");
    const percent = qualityPercent(row);
    verdict.append(
      el(
        "strong",
        "quality-score",
        percent === null ? "Оцінка у % ще не виставлена" : `${percent}%`,
      ),
    );
    if (percent !== null && row.qualityScore) {
      const score = row.qualityScore;
      verdict.append(
        details(
          "Як оцінено",
          el(
            "p",
            "",
            `Правильність фактів: ${score.correctness}/40. Повнота: ${score.completeness}/30. Опора на джерела: ${score.grounding}/20. Робота з невизначеністю: ${score.uncertainty}/10.`,
          ),
          el("p", "", score.reason),
        ),
      );
    }

    const label = verdictLabel(row.verdict);
    verdict.append(
      badge(
        label,
        label === "Успішно"
          ? "success"
          : label === "Невдача"
            ? "danger"
            : "warning",
      ),
      el("p", "", row.explanation || "Оцінювання ще не завершене."),
    );
    if (row.inventedFacts === true)
      verdict.append(
        el("p", "error-text", "Є непідтверджене фактичне твердження."),
      );
    tr.append(q, reference, actual, verdict);
    body.append(tr);
  });
  table.append(body);
  wrapper.append(table);
  return wrapper;
}

export function failureBreakdown(rows: ResultRow[]): HTMLElement {
  const section = el("section", "evaluation-failures");
  section.append(el("h2", "", "Розбір невдач"));
  const failures = failedRows(rows);
  if (!failures.length) {
    section.append(
      el(
        "p",
        "muted",
        rows.some((row) => verdictLabel(row.verdict) === "Ще не оцінено")
          ? "Оцінювання ще не завершене. Відсутність позначених невдач не означає, що всі відповіді правильні."
          : "В оцінених відповідях цього прогону невдач не зафіксовано. Це не гарантує правильності інших відповідей.",
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
      el("p", "", row.explanation || "Причину ще не описано."),
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
          "Технічна помилка запиту. Не зараховується як правильне «не знаю».",
        ),
      );
    if (row.inventedFacts === true)
      entry.append(
        el("p", "error-text", "Відповідь містить непідтверджений факт."),
      );
    section.append(entry);
  }
  return section;
}
