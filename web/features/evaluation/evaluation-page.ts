import {
  evaluationText,
  type EvaluationLanguage,
} from "./evaluation-language.js";
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
  const host = el("div");
  let language: EvaluationLanguage = "en";
  const state: EvaluationViewState = {};
  function show() {
    host.replaceChildren(
      renderEvaluation(
        language,
        (next) => {
          language = next;
          show();
        },
        state,
      ),
    );
  }
  show();
  return host;
}

interface EvaluationViewState {
  request?: Promise<{ runs: EvaluationRun[] }>;
  selectedRun?: string;
  filter?: string;
}

function renderEvaluation(
  language: EvaluationLanguage,
  changeLanguage: (next: EvaluationLanguage) => void,
  state: EvaluationViewState,
): HTMLElement {
  const t = evaluationText(language);
  const page = el("section", "explore-page");
  page.lang = language;
  const languages = el("div", "view-controls");
  for (const [value, label] of [
    ["en", "English"],
    ["uk", "Українська"],
  ] as const) {
    const control = button(label, () => changeLanguage(value));
    control.setAttribute("aria-pressed", String(language === value));
    languages.append(control);
  }
  page.append(languages);
  page.append(
    el("p", "eyebrow", t("QUALITY REVIEW", "ПЕРЕВІРКА ЯКОСТІ")),
    el("h1", "", t("Answer evaluation", "Оцінювання відповідей")),
    el(
      "p",
      "lede",
      t(
        "Current summary, answer grades and an honest breakdown of limitations. Viewing saved results does not trigger paid requests.",
        "Поточний підсумок, оцінки відповідей і чесний розбір недоліків. Перегляд збережених результатів не запускає платних запитів.",
      ),
    ),
  );
  page.append(
    el(
      "p",
      "muted small",
      t(
        "Language changes the interface and translated assessment notes. Saved questions, reference answers, model responses and evidence remain in their original language.",
        "Перемикач змінює мову інтерфейсу та перекладених пояснень оцінки. Збережені питання, еталонні відповіді, відповіді моделі й докази залишаються мовою оригіналу.",
      ),
    ),
  );
  const content = el("div");
  page.append(content);
  async function load() {
    content.replaceChildren(
      el("p", "muted", t("Loading results…", "Завантажуємо результати…")),
    );
    try {
      // Read stored answers and verdicts only. Opening this page never reruns evaluation.
      state.request ??= getJson<{ runs: EvaluationRun[] }>("/api/evaluations");
      const { runs: savedRuns } = await state.request;
      // Published run IDs define the comparison; an updated view may combine saved rechecks.
      const runs = publicEvaluations(savedRuns);
      if (!runs.length) {
        content.replaceChildren(
          empty(
            t("No saved evaluation yet", "Ще немає збереженого оцінювання"),
            t(
              "Results will appear after answers are generated and assessed. Accuracy is not established yet.",
              "Результати з’являться після запуску й оцінювання відповідей. Точність поки не визначена.",
            ),
          ),
        );
        return;
      }
      const controls = el("div", "view-controls");
      const runLabel = el("label", "", t("Run", "Прогін"));
      const select = el("select");
      select.id = "evaluation-run";
      runLabel.htmlFor = select.id;
      for (const run of runs) {
        const option = el(
          "option",
          "",
          t(
            `${date(run.createdAt)} · ${run.mode === "mcp" ? "Model + Everstake MCP data" : run.viewKind === "updated" ? "Current summary · 20 questions" : run.recheckOf ? "Recheck" : run.questionSet === "scenarios" ? "Real-world scenarios" : "Historical run · 20 questions"} · ${run.questionSetVersion ?? "original"} · ${run.mode} · ${run.status}`,
            `${date(run.createdAt)} · ${run.mode === "mcp" ? "Модель + дані Everstake MCP" : run.viewKind === "updated" ? "Поточний підсумок · 20 питань" : run.recheckOf ? "Повторна перевірка" : run.questionSet === "scenarios" ? "Життєві сценарії" : "Історичний прогін · 20 питань"} · ${run.questionSetVersion ?? "original"} · ${run.mode} · ${run.status}`,
          ),
        );
        option.value = run.id;
        select.append(option);
      }
      select.value =
        state.selectedRun ??
        (runs.find((run) => run.viewKind === "updated") ??
          defaultEvaluationRun(runs))!.id;
      const filterLabel = el(
        "label",
        "",
        t("Show in table", "Показати в таблиці"),
      );
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
              value === "all"
                ? t("All results", "Усі результати")
                : verdictLabel(value, language),
            );
            option.value = value;
            filter.append(option);
          }
          if (
            state.filter &&
            [...filter.options].some((option) => option.value === state.filter)
          )
            filter.value = state.filter;
        }
        state.selectedRun = select.value;
        state.filter = filter.value;
        const stats = el("div", "metrics");
        stats.append(
          metric(
            run.viewKind === "updated"
              ? t("Confirmed answers", "Підтверджені відповіді")
              : t("Accuracy of this run", "Точність цього прогону"),
            run.viewKind === "updated"
              ? `${summary.passed} / ${progress.planned}`
              : summary.accuracy === null
                ? t("Not established", "Не визначено")
                : progress.accuracy,
            run.viewKind === "updated"
              ? t(
                  `Hard questions · average score ${averageQuality(run)?.toFixed(2) ?? "not established"}/100`,
                  `Складні питання · середня оцінка ${averageQuality(run)?.toFixed(2).replace(".", ",") ?? "не визначена"}/100`,
                )
              : t(
                  `${summary.passed} passed out of ${progress.planned} planned`,
                  `${summary.passed} успішних із ${progress.planned} запланованих`,
                ),
          ),
          metric(
            t("Assessed", "Оцінено"),
            `${summary.assessed} / ${progress.planned}`,
            t(
              `${summary.failed} failed · ${progress.awaitingAssessment} awaiting assessment · ${progress.notRun} not run`,
              `${summary.failed} невдач · ${progress.awaitingAssessment} ще не оцінено · ${progress.notRun} не запущено`,
            ),
          ),
          metric(
            t("Answers with invented facts", "Відповіді з вигаданими фактами"),
            summary.inventedFacts === null
              ? t("Not established", "Не визначено")
              : String(summary.inventedFacts),
            t(
              `Among ${summary.assessed} assessed questions`,
              `Серед ${summary.assessed} оцінених питань`,
            ),
          ),
          metric(
            run.viewKind === "updated"
              ? t(
                  "Cost of the base run and rechecks",
                  "Вартість основного й повторних прогонів",
                )
              : t("Measured run cost", "Виміряна вартість прогону"),
            money(summary.knownCostUsd),
            summary.unknownCalls
              ? t(
                  `${summary.unknownCalls} calls with unknown cost`,
                  `${summary.unknownCalls} викликів із невідомою вартістю`,
                )
              : t("Based on recorded token usage", "За використаними токенами"),
          ),
        );
        const version = el(
          "p",
          "muted small",
          run.viewKind === "updated"
            ? t(
                `Result sources: ${run.sourceRunIds!.join(", ")} · Corpus ${run.corpusVersion}`,
                `Джерела результатів: ${run.sourceRunIds!.join(", ")} · Корпус ${run.corpusVersion}`,
              )
            : t(
                `Run ${run.id} · Corpus ${run.corpusVersion} · ${run.questionSetVersion ?? "original question set"}`,
                `Прогін ${run.id} · Корпус ${run.corpusVersion} · ${run.questionSetVersion ?? "початковий набір"}`,
              ),
        );
        const statusBadge = badge(
          run.status === "completed" && !progress.assessmentComplete
            ? t(
                "Answers saved, assessment incomplete",
                "Відповіді збережено, оцінювання не завершене",
              )
            : run.viewKind === "updated"
              ? t("Current summary", "Поточний підсумок")
              : run.status,
          run.status === "completed" && progress.assessmentComplete
            ? ""
            : "warning",
        );
        overview.replaceChildren(
          el("h2", "", t("Evaluation metrics", "Метрики оцінювання")),
          el(
            "p",
            "muted",
            t(
              "The percentage next to an answer is its rubric score: facts — 40 points, completeness — 30, sources — 20, uncertainty — 10. It is a score against criteria, not a probability of correctness. Pass/fail separately indicates whether the question was fully answered. Older runs without rubric scores do not receive a percentage automatically.",
              "Відсоток біля відповіді показує оцінку її якості: факти — 40 балів, повнота — 30, джерела — 20, невизначеність — 10. Це оцінка за критеріями, а не ймовірність правильності. Успіх/невдача окремо показує повне виконання питання. Старі прогони без такої оцінки не отримують відсоток автоматично.",
            ),
          ),
          stats,
          version,
          statusBadge,
          el(
            "p",
            "muted small",
            t(
              `${progress.completed} saved answers · ${progress.errors} answers with technical errors · ${progress.notRun} questions without a saved answer.`,
              `${progress.completed} збережених відповідей · ${progress.errors} відповідей із технічною помилкою · ${progress.notRun} питань без збереженої відповіді.`,
            ),
          ),
          el(
            "p",
            "muted small",
            t(
              "A pass means the question criteria were met. A missing essential part or technical failure is a fail. An appropriate abstention on a negative case can pass. Filtering the table does not change metrics or the failure breakdown.",
              "Успіх означає виконання критеріїв питання. Пропущена суттєва частина або технічний збій — невдача. Правильне «не знаю» у негативному випадку може бути успіхом. Фільтр таблиці не змінює метрик чи розбору невдач.",
            ),
          ),
        );
        if (run.viewKind === "updated")
          overview.prepend(
            el(
              "p",
              "notice",
              t(
                `The table shows the latest assessed answer for each question. After a fix, ${run.recheckedCount} of ${progress.planned} questions were rechecked; the remaining answers come from the base run. This combines several saved checks and is not a new full run. Previous results are available in the selector.`,
                `У таблиці — остання оцінена відповідь на кожне питання. Після виправлення повторно перевірено ${run.recheckedCount} із ${progress.planned}; решта відповідей — з основного прогону. Це підсумок кількох перевірок, а не новий повний прогін. Попередні результати доступні у списку.`,
              ),
            ),
          );
        if (run.recheckOf)
          overview.append(
            el(
              "p",
              "notice",
              t(
                `This rechecks selected questions from run ${run.recheckOf}. The remaining questions were not run here.`,
                `Це повторна перевірка окремих питань із прогону ${run.recheckOf}. Решта питань тут не запускалася.`,
              ),
            ),
          );
        list.replaceChildren(
          failureBreakdown(run.rows, language),
          el(
            "h2",
            "",
            t(
              `Evaluation table: ${progress.planned} questions`,
              `Таблиця оцінювання: ${progress.planned} запитань`,
            ),
          ),
          el(
            "p",
            "muted small",
            run.questionSet === "scenarios"
              ? t(
                  "Additional real-world scenarios. Their results are excluded from the main 20-question metrics.",
                  "Додаткові життєві сценарії. Їхні результати не входять у метрики основних 20 питань.",
                )
              : t(
                  "The main set includes five negative cases. A correct answer must honestly state what the sources do not establish.",
                  "Основний набір містить п’ять негативних випадків. Для них правильна відповідь має чесно вказати, чого джерела не встановлюють.",
                ),
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
                language,
              ),
            );
        }
        // Filtering affects table visibility only, never the full-run metrics or failure counts.
        const rows = filterRows(run.rows, filter.value);
        list.append(evaluationTable(rows, run.id, language));
        if (!rows.length)
          list.append(
            empty(
              t(
                "No results match this filter",
                "Немає результатів за цим фільтром",
              ),
              t("Choose another filter.", "Оберіть інший фільтр."),
            ),
          );
      }
      select.addEventListener("change", () => render(true));
      filter.addEventListener("change", () => render());
      render(true);
    } catch (error) {
      state.request = undefined;
      content.replaceChildren(
        empty(
          t("Could not load evaluation", "Не вдалося завантажити оцінювання"),
          (error as Error).message,
        ),
        button(t("Try again", "Спробувати ще раз"), () => void load()),
      );
    }
  }
  void load();
  return page;
}
