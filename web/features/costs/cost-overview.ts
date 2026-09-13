import type { Receipt } from "../../../src/contracts.js";
import {
  badge,
  button,
  details,
  el,
  empty,
  getJson,
  metric,
  money,
} from "../../shared/dom.js";
import { date } from "../../shared/source-date.js";
import { activityLabel, activityTitle } from "./activity-label.js";
import { costReceipt } from "./cost-receipt.js";
interface Attempt {
  id: string;
  stage: string;
  provider: string;
  model: string;
  attempt: number;
  startedAt: string;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  status: string;
}
interface CostRun {
  id: string;
  kind: string;
  startedAt: string;
  status: string;
  question: string | null;
  receipt: Receipt & { attempts?: Attempt[] };
}
interface Overview {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  knownCostUsd: number;
  unknownCalls: number;
  pendingCalls: number;
  byModel: Array<{
    provider: string;
    model: string;
    calls: number;
    knownCostUsd: number;
    unknownCalls: number;
  }>;
  runs: CostRun[];
}
export function costOverview(): HTMLElement {
  const page = el("section", "explore-page");
  page.append(
    el("p", "eyebrow", "MEASURED, NOT GUESSED"),
    el("h1", "", "Know the cost of knowing."),
    el(
      "p",
      "lede",
      "Recorded spending for answers, source collection, and evaluations. Unconfirmed charges stay visible until usage is known.",
    ),
  );
  const content = el("div");
  page.append(content);
  async function load() {
    content.replaceChildren(el("p", "muted", "Loading recorded costs…"));
    try {
      const data = await getJson<Overview>("/api/costs");
      const metrics = el("div", "metrics");
      metrics.append(
        metric(
          "All-time known cost",
          money(data.knownCostUsd),
          "All recorded categories",
        ),
        metric("Model calls", data.calls.toLocaleString()),
        metric(
          "Unconfirmed costs",
          String(data.unknownCalls),
          `${data.pendingCalls} calls still pending`,
        ),
        metric(
          "Input / output tokens",
          `${data.inputTokens.toLocaleString()} / ${data.outputTokens.toLocaleString()}`,
        ),
      );
      content.replaceChildren(metrics);
      const byModel = el("div", "model-costs");
      for (const model of data.byModel) {
        const row = el("div", "model-cost-row");
        row.append(
          el("strong", "", model.model),
          el("span", "muted small", `${model.provider} · ${model.calls} calls`),
          el(
            "span",
            "",
            `${money(model.knownCostUsd)}${model.unknownCalls ? " + unconfirmed" : ""}`,
          ),
        );
        byModel.append(row);
      }
      if (data.byModel.length)
        content.append(details("Spending by model", byModel));
      const controls = el("div", "section-heading");
      const title = el("h2", "", "Recent activity");
      const filter = el("select");
      filter.setAttribute("aria-label", "Filter costs by activity");
      for (const value of [
        "all",
        ...new Set((data.runs ?? []).map((run) => run.kind)),
      ]) {
        const option = el(
          "option",
          "",
          value === "all" ? "All activity" : activityLabel(value),
        );
        option.value = value;
        filter.append(option);
      }
      controls.append(title, filter);
      const subtotal = el("p", "muted small");
      const rows = el("div", "cost-list");
      content.append(controls, subtotal, rows);
      const render = () => {
        const selected = (data.runs ?? []).filter(
          (run) => filter.value === "all" || run.kind === filter.value,
        );
        const sum = selected.reduce(
          (value, run) => value + run.receipt.knownCostUsd,
          0,
        );
        subtotal.textContent = `${selected.length} displayed runs · Known subtotal ${money(sum)}. Showing up to 100 recent runs; the all-time total above includes older activity.`;
        rows.replaceChildren();
        for (const run of selected) {
          const row = el("article", "cost-run");
          const heading = el("div", "section-heading");
          heading.append(
            el("h3", "", activityTitle(run.kind, run.question, run.id)),
            el("strong", "cost-amount", money(run.receipt.knownCostUsd)),
          );
          row.append(
            heading,
            el(
              "p",
              "small muted",
              `${date(run.startedAt)} · ${activityLabel(run.kind)}`,
            ),
            badge(
              run.status,
              ["failed", "error"].includes(run.status) ? "danger" : "",
            ),
            costReceipt(run.receipt, "Activity receipt"),
          );
          rows.append(row);
        }
        if (!selected.length)
          rows.append(
            empty(
              "No recorded activity",
              "Costs will appear after answers, collection work, or evaluations run.",
            ),
          );
      };
      filter.addEventListener("change", render);
      render();
    } catch (error) {
      content.replaceChildren(
        empty("Costs unavailable", (error as Error).message),
        button("Try again", () => void load()),
      );
    }
  }
  void load();
  return page;
}
