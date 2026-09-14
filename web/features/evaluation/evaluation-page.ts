import { averageQuality } from "./average-quality.js";
import { matchingMcpRun, mcpComparison } from "./mcp-comparison.js";
import { publicEvaluations } from "./current-evaluation.js";
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
import type { ResultRow } from "./question-result-card.js";
import {
  evaluationTable,
  failureBreakdown,
  verdictLabel,
} from "./evaluation-table.js";
export interface EvaluationRun {
  id: string;
  createdAt: string;
  corpusVersion: string;
  plannedTotal?: number;
  mode: string;
  status: string;
  questionSet?: string;
  questionSetVersion?: string;
  recheckOf?: string;
  viewKind?: "updated";
  baseRunId?: string;
  recheckedCount?: number;
  sourceRunIds?: string[];
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
    : rows.filter((row) => (row.verdict || "ungraded") === verdict);
}
export function evaluationPage(): HTMLElement {
  const page = el("section", "explore-page");
  page.append(
    el("p", "eyebrow", "ПЕРЕВІРКА ЯКОСТІ"),
    el("h1", "", "Оцінювання відповідей"),
    el(
      "p",
      "lede",
      "Поточний підсумок, оцінки відповідей і чесний розбір недоліків. Перегляд збережених результатів не запускає платних запитів.",
    ),
  );
  const content = el("div");
  page.append(content);
  async function load() {
    content.replaceChildren(el("p", "muted", "Завантажуємо результати…"));
    try {
      // Read stored answers and verdicts only. Opening this page never reruns evaluation.
      const { runs: savedRuns } = await getJson<{ runs: EvaluationRun[] }>(
        "/api/evaluations",
      );
      // Published run IDs define the comparison; an updated view may combine saved rechecks.
      const runs = publicEvaluations(savedRuns);
      if (!runs.length) {
        content.replaceChildren(
          empty(
            "Ще немає збереженого оцінювання",
            "Результати з’являться після запуску й оцінювання відповідей. Точність поки не визначена.",
          ),
        );
        return;
      }
      const controls = el("div", "view-controls");
      const runLabel = el("label", "", "Прогін");
      const select = el("select");
      select.id = "evaluation-run";
      runLabel.htmlFor = select.id;
      for (const run of runs) {
        const option = el(
          "option",
          "",
          `${date(run.createdAt)} · ${run.mode === "mcp" ? "Модель + дані Everstake MCP" : run.viewKind === "updated" ? "Поточний підсумок · 20 питань" : run.recheckOf ? "Повторна перевірка" : run.questionSet === "scenarios" ? "Життєві сценарії" : "Історичний прогін · 20 питань"} · ${run.questionSetVersion ?? "original"} · ${run.mode} · ${run.status}`,
        );
        option.value = run.id;
        select.append(option);
      }
      select.value = (runs.find((run) => run.viewKind === "updated") ??
        defaultEvaluationRun(runs))!.id;
      const filterLabel = el("label", "", "Показати в таблиці");
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
              value === "all" ? "Усі результати" : verdictLabel(value),
            );
            option.value = value;
            filter.append(option);
          }
        }
        const stats = el("div", "metrics");
        stats.append(
          metric(
            run.viewKind === "updated"
              ? "Підтверджені відповіді"
              : "Точність цього прогону",
            run.viewKind === "updated"
              ? `${summary.passed} / ${progress.planned}`
              : summary.accuracy === null
                ? "Не визначено"
                : progress.accuracy,
            run.viewKind === "updated"
              ? `Складні питання · середня оцінка ${averageQuality(run)?.toFixed(2).replace(".", ",") ?? "не визначена"}/100`
              : `${summary.passed} успішних із ${progress.planned} запланованих`,
          ),
          metric(
            "Оцінено",
            `${summary.assessed} / ${progress.planned}`,
            `${summary.failed} невдач · ${progress.awaitingAssessment} ще не оцінено · ${progress.notRun} не запущено`,
          ),
          metric(
            "Відповіді з вигаданими фактами",
            summary.inventedFacts === null
              ? "Не визначено"
              : String(summary.inventedFacts),
            `Серед ${summary.assessed} оцінених питань`,
          ),
          metric(
            run.viewKind === "updated"
              ? "Вартість основного й повторних прогонів"
              : "Виміряна вартість прогону",
            money(summary.knownCostUsd),
            summary.unknownCalls
              ? `${summary.unknownCalls} викликів із невідомою вартістю`
              : "За використаними токенами",
          ),
        );
        const version = el(
          "p",
          "muted small",
          run.viewKind === "updated"
            ? `Джерела результатів: ${run.sourceRunIds!.join(", ")} · Корпус ${run.corpusVersion}`
            : `Прогін ${run.id} · Корпус ${run.corpusVersion} · ${run.questionSetVersion ?? "початковий набір"}`,
        );
        const state = badge(
          run.status === "completed" && !progress.assessmentComplete
            ? "Відповіді збережено, оцінювання не завершене"
            : run.viewKind === "updated"
              ? "Поточний підсумок"
              : run.status,
          run.status === "completed" && progress.assessmentComplete
            ? ""
            : "warning",
        );
        overview.replaceChildren(
          el("h2", "", "Метрики оцінювання"),
          el(
            "p",
            "muted",
            "Відсоток біля відповіді показує оцінку її якості: факти — 40 балів, повнота — 30, джерела — 20, невизначеність — 10. Це оцінка за критеріями, а не ймовірність правильності. Успіх/невдача окремо показує повне виконання питання. Старі прогони без такої оцінки не отримують відсоток автоматично.",
          ),
          stats,
          version,
          state,
          el(
            "p",
            "muted small",
            `${progress.completed} збережених відповідей · ${progress.errors} відповідей із технічною помилкою · ${progress.notRun} питань без збереженої відповіді.`,
          ),
          el(
            "p",
            "muted small",
            "Успіх означає виконання критеріїв питання. Пропущена суттєва частина або технічний збій — невдача. Правильне «не знаю» у негативному випадку може бути успіхом. Фільтр таблиці не змінює метрик чи розбору невдач.",
          ),
        );
        if (run.viewKind === "updated")
          overview.prepend(
            el(
              "p",
              "notice",
              `У таблиці — остання оцінена відповідь на кожне питання. Після виправлення повторно перевірено ${run.recheckedCount} із ${progress.planned}; решта відповідей — з основного прогону. Це підсумок кількох перевірок, а не новий повний прогін. Попередні результати доступні у списку.`,
            ),
          );
        if (run.recheckOf)
          overview.append(
            el(
              "p",
              "notice",
              `Це повторна перевірка окремих питань із прогону ${run.recheckOf}. Решта питань тут не запускалася.`,
            ),
          );
        list.replaceChildren(
          failureBreakdown(run.rows),
          el("h2", "", `Таблиця оцінювання: ${progress.planned} запитань`),
          el(
            "p",
            "muted small",
            run.questionSet === "scenarios"
              ? "Додаткові життєві сценарії. Їхні результати не входять у метрики основних 20 питань."
              : "Основний набір містить п’ять негативних випадків. Для них правильна відповідь має чесно вказати, чого джерела не встановлюють.",
          ),
        );
        const comparisonBase =
          run.viewKind === "updated"
            ? runs.find((item) => item.id === run.baseRunId)
            : run;
        if (comparisonBase?.mode === "agent" && !comparisonBase.recheckOf) {
          const mcp = matchingMcpRun(comparisonBase, runs);
          if (mcp)
            list.prepend(
              mcpComparison(
                comparisonBase,
                mcp,
                run.viewKind === "updated" ? run : undefined,
              ),
            );
        }
        // Filtering affects table visibility only, never the full-run metrics or failure counts.
        const rows = filterRows(run.rows, filter.value);
        list.append(evaluationTable(rows, run.id));
        if (!rows.length)
          list.append(
            empty("Немає результатів за цим фільтром", "Оберіть інший фільтр."),
          );
      }
      select.addEventListener("change", () => render(true));
      filter.addEventListener("change", () => render());
      render(true);
    } catch (error) {
      content.replaceChildren(
        empty("Не вдалося завантажити оцінювання", (error as Error).message),
        button("Спробувати ще раз", () => void load()),
      );
    }
  }
  void load();
  return page;
}
