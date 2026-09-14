import {
  evaluationText,
  type EvaluationLanguage,
} from "./evaluation-language.js";
import submission from "../../../assistant/config/evaluation-submission.json" with { type: "json" };
import { el, money } from "../../shared/dom.js";
import type { EvaluationRun } from "./evaluation-page.js";

export function matchingMcpRun(
  base: EvaluationRun,
  runs: EvaluationRun[],
): EvaluationRun | undefined {
  const questions = (run: EvaluationRun) =>
    run.rows
      .map((row) =>
        typeof row.question === "string"
          ? row.question
          : `${row.question.id}\n${row.question.question}`,
      )
      .sort();
  const expected = questions(base);
  return [...runs]
    .sort(
      (a, b) =>
        Number(b.id === submission.comparator) -
          Number(a.id === submission.comparator) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .find(
      (run) =>
        run.mode === "mcp" &&
        run.status === "completed" &&
        run.rows.length === 20 &&
        run.summary.assessed === 20 &&
        new Set(questions(run)).size === 20 &&
        JSON.stringify(questions(run)) === JSON.stringify(expected),
    );
}
export function mcpComparison(
  base: EvaluationRun,
  mcp: EvaluationRun,
  updated?: EvaluationRun,
  language: EvaluationLanguage = "en",
): HTMLElement {
  const t = evaluationText(language);
  const section = el("section", "evaluation-comparison");
  section.append(
    el(
      "h2",
      "",
      t("Comparison with Everstake MCP", "Порівняння з Everstake MCP"),
    ),
    el(
      "p",
      "",
      t(
        "One model, the same 20 questions, different sources and workflows. Our agent searches the collected corpus. The MCP variant receives only saved Everstake MCP tool responses and one attempt to write an answer. MCP itself is not an answer-generating model.",
        "Одна модель, ті самі 20 питань, різні джерела й способи роботи. Наш агент шукає в зібраному корпусі. Варіант MCP отримує лише збережені відповіді інструментів Everstake MCP й одну спробу написати відповідь. MCP сам не є моделлю, що генерує відповіді.",
      ),
    ),
  );
  const wrap = el("div", "evaluation-table-wrap"),
    table = el("table", "evaluation-table");
  const head = el("thead"),
    header = el("tr");
  for (const text of [
    t("Approach", "Варіант"),
    t("Fully answered", "Виконано повністю"),
    t("Invented-fact cases", "Вигадані факти: випадки"),
    t("Answer cost", "Вартість відповідей"),
  ]) {
    const th = el("th", "", text);
    th.scope = "col";
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = el("tbody");
  for (const [name, run] of [
    [t("Our agent · full run", "Наш агент · повний прогін"), base],
    [t("Same model + MCP data only", "Та сама модель + лише MCP-дані"), mcp],
    ...(updated
      ? [
          [
            t(
              `Our agent · summary with ${updated.recheckedCount} rechecked questions`,
              `Наш агент · підсумок із повтором ${updated.recheckedCount} питань`,
            ),
            updated,
          ],
        ]
      : []),
  ] as [string, EvaluationRun][]) {
    const row = el("tr");
    for (const text of [
      name,
      `${run.summary.passed}/20`,
      String(run.summary.inventedFacts ?? t("Not assessed", "Не оцінено")),
      money(run.summary.knownCostUsd),
    ])
      row.append(el("td", "", text));
    body.append(row);
  }
  table.append(body);
  wrap.append(table);
  section.append(
    wrap,
    el(
      "p",
      "muted",
      t(
        "MCP: 6 passes — the certifications answer and five correct abstentions. The remaining questions needed article details or history absent from the captured MCP responses. This measures coverage of these questions, not an overall ranking of tools.",
        "MCP: 6 успіхів — відповідь про сертифікації та п’ять правильних відмов. Решта питань потребувала деталей статей або історії, яких у зафіксованих відповідях MCP не було. Це перевірка покриття цих питань, а не загальний рейтинг інструментів.",
      ),
    ),
    el(
      "p",
      "",
      t(
        "Where our approach helps more: history, conflicting sources, exact excerpts and date explanations. Where MCP helps more: direct access to Everstake operational data and the calculator without maintaining a corpus. Our approach requires collection, updates and checks; it costs more and can miss sources.",
        "Де наш підхід корисніший: історія, зіставлення суперечливих джерел, точні уривки та пояснення дат. Де MCP корисніший: прямий доступ до операційних даних Everstake й калькулятора без підтримки власного корпусу. Наш підхід потребує збору, оновлення та перевірок; він дорожчий і може пропускати джерела.",
      ),
    ),
    el(
      "p",
      "muted small",
      t(
        "MCP responses were captured on 13 September 2026. No integration requests were submitted. This run did not measure autonomous MCP tool selection, tool latency or a freshness advantage. Assessment was performed by a coding assistant; this is not a blind test. The base run and rechecks are not presented as a new full run.",
        "Відповіді MCP зафіксовано 13 вересня 2026 року. Інтеграційні заявки не надсилали. Автономний вибір MCP-інструментів, їхню затримку та перевагу в актуальності цим прогоном не вимірювали. Оцінювання виконано coding assistant; це не сліпий тест. Основний прогін і повторні перевірки не змішані в один новий прогін.",
      ),
    ),
  );
  return section;
}
