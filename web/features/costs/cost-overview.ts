import type { CostDashboard } from "../../../src/services/measurements/cost-dashboard.js";
import {
  badge,
  button,
  details,
  el,
  empty,
  getJson,
  money,
} from "../../shared/dom.js";
import { activityLabel, activityTitle } from "./activity-label.js";
import { costReceipt } from "./cost-receipt.js";

function panel(title: string, note?: string): HTMLElement {
  const box = el("section", "cost-panel");
  box.append(el("h2", "", title));
  if (note) box.append(el("p", "cost-note", note));
  return box;
}
function stat(label: string, value: string, note: string): HTMLElement {
  const node = el("div", "cost-stat");
  node.append(
    el("span", "eyebrow", label),
    el("strong", "", value),
    el("small", "", note),
  );
  return node;
}
function bars(
  items: {
    label: string;
    knownCostUsd: number;
    calls: number;
    unknownCalls: number;
  }[],
  label: (key: string) => string = (key) => key,
): HTMLElement {
  const chart = el("div", "cost-bars");
  const max = Math.max(0, ...items.map((item) => item.knownCostUsd));
  for (const item of items) {
    const row = el("div", "cost-bar-row");
    const name = el("span", "cost-bar-label", label(item.label));
    name.title = `${label(item.label)} · ${item.calls} calls · ${item.unknownCalls} unconfirmed`;
    const track = el("span", "cost-bar-track");
    const bar = el("span", "cost-bar-fill");
    bar.style.width = `${max ? (item.knownCostUsd / max) * 100 : 0}%`;
    track.append(bar);
    const value = el("span", "cost-bar-value", money(item.knownCostUsd));
    row.append(name, track, value);
    chart.append(row);
  }
  if (!items.length)
    chart.append(el("p", "cost-note", "No provider calls recorded yet."));
  return chart;
}
export function costOverview(): HTMLElement {
  const page = el("section", "explore-page costs-page");
  page.append(
    el("p", "eyebrow", "MEASURED, NOT GUESSED"),
    el("h1", "", "What does the knowledge base cost?"),
    el(
      "p",
      "lede",
      "See the average cost of one question and one update, then where the money went: Soniox transcription, Gemini answers and reviews, and OpenAI embeddings.",
    ),
  );
  const content = el("div");
  page.append(content);
  async function load() {
    content.replaceChildren(el("p", "muted", "Loading recorded costs…"));
    try {
      const data = await getJson<CostDashboard>("/api/costs");
      const stats = el("div", "cost-stats");
      stats.append(
        stat(
          "One question · average",
          data.query.meanUsd === null
            ? "No sample yet"
            : `≈ ${money(data.query.meanUsd)}`,
          `${data.query.measuredRuns} completed, fully priced queries · ${data.query.excludedRuns} excluded`,
        ),
        stat(
          "One update run · average",
          data.update.meanUsd === null
            ? "No sample yet"
            : `≈ ${money(data.update.meanUsd)}`,
          `${data.update.measuredRuns} completed, fully priced updates · ${data.update.excludedRuns} excluded`,
        ),
        stat(
          "Total recorded spending",
          money(data.knownCostUsd),
          `${data.calls.toLocaleString()} provider calls · known charges across all activity`,
        ),
        stat(
          "Costs still unknown",
          String(data.unknownCalls),
          `${data.pendingCalls} pending · ${data.unpricedFinalCalls} finished without price`,
        ),
      );
      const sampleNote = el("p", "cost-sample-note");
      sampleNote.textContent =
        "Averages describe recorded successful runs, not a quote for the next request. Failed or unpriced runs are excluded from averages, but their known charges remain in total spending. One update run can check one source or several; a full Updates pass can contain many runs.";
      const providers = el("div", "cost-provider-grid");
      const providerNames: Record<string, { name: string; purpose: string }> = {
        soniox: { name: "Soniox", purpose: "Video transcription" },
        gemini: { name: "Gemini", purpose: "Answers, extraction & reviews" },
        openai: { name: "OpenAI", purpose: "Search & index embeddings" },
      };
      for (const provider of data.byProvider) {
        const description = providerNames[provider.provider] ?? {
          name: provider.provider,
          purpose: "Other recorded provider activity",
        };
        const box = panel(description.name);
        box.classList.add("cost-provider-card");
        const headline = el("div", "cost-provider-total");
        headline.append(
          el("span", "", `${description.purpose} · known cost`),
          el(
            "strong",
            "",
            provider.calls ? money(provider.knownCostUsd) : "No activity",
          ),
        );
        box.append(headline);
        for (const model of provider.models) {
          const modelRow = el("div", "cost-provider-model");
          const modelHeading = el("div", "cost-model-heading");
          modelHeading.append(
            el("strong", "", model.model),
            el("strong", "", money(model.knownCostUsd)),
          );
          modelRow.append(
            modelHeading,
            el(
              "p",
              "cost-note",
              provider.provider === "soniox"
                ? `${model.calls} transcription attempts · ${model.unknownCalls} unpriced`
                : `${model.calls} calls · ${model.inputTokens.toLocaleString()} in / ${model.outputTokens.toLocaleString()} out tokens`,
            ),
          );
          box.append(modelRow);
        }
        box.append(
          el(
            "p",
            "cost-provider-state",
            `${provider.pendingCalls} pending · ${provider.unpricedFinalCalls} finished unpriced · ${provider.errorCalls} failed/cancelled`,
          ),
        );
        providers.append(box);
      }
      const ribbon = el("div", "cost-ribbon");
      ribbon.append(
        el(
          "span",
          "",
          `Tokens ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out`,
        ),
        el(
          "span",
          "",
          `${data.errorCalls} failed, timed out or cancelled calls`,
        ),
        el(
          "span",
          "",
          data.query.minUsd === null
            ? "Query range unavailable"
            : `Query range ${money(data.query.minUsd)}–${money(data.query.maxUsd!)} · ${data.query.excludedRuns} incomplete/unpriced excluded`,
        ),
      );
      ribbon.append(
        el(
          "span",
          "",
          data.update.minUsd === null
            ? "Update range: no completed priced sample"
            : `Update range ${money(data.update.minUsd)}–${money(data.update.maxUsd!)} · ${money(data.update.knownCostUsd)} across all update runs`,
        ),
      );
      const columns = el("div", "cost-columns");
      const purposes = panel(
        "Where spending goes",
        "All-time known USD · each call counted once under its root operation.",
      );
      purposes.append(bars(data.byPurpose, activityLabel));
      const models = panel(
        "Providers & models",
        "Known usage cost. Unconfirmed calls are additional, not free.",
      );
      for (const model of [...data.byModel].sort(
        (a, b) => b.knownCostUsd - a.knownCostUsd,
      )) {
        const row = el("div", "cost-model");
        const heading = el("div", "cost-model-heading");
        heading.append(
          el("strong", "", model.model),
          el("strong", "", money(model.knownCostUsd)),
        );
        row.append(
          heading,
          el(
            "p",
            "cost-note",
            `${model.provider} · ${model.calls.toLocaleString()} calls · ${model.unknownCalls} unconfirmed`,
          ),
        );
        models.append(row);
      }
      if (!data.byModel.length)
        models.append(el("p", "cost-note", "No model usage recorded yet."));
      columns.append(purposes, models);
      const trends = el("div", "cost-columns");
      const daily = panel(
        "Daily spending",
        "Last 14 recorded UTC dates · known charges by call start date.",
      );
      daily.append(bars(data.daily.slice(-14)));
      const stages = panel(
        "Cost by processing stage",
        "See how answering, verification and extraction contribute.",
      );
      stages.append(bars(data.byStage, (value) => value.replaceAll("_", " ")));
      trends.append(daily, stages);
      const forecast = el("div", "cost-forecast");
      forecast.append(
        el("strong", "", "50× corpus · forecast, not a charge"),
        el(
          "p",
          "",
          `${money(data.forecast.knownIndexCostUsd)} recorded index/embedding cost × 50 = ${money(data.forecast.projectedIndexCostUsd)}. ${data.forecast.inputTokens.toLocaleString()} input tokens × 50 = ${data.forecast.projectedInputTokens.toLocaleString()}.`,
        ),
        el(
          "p",
          "cost-note",
          `Assumes the same document mix, token volume per document, processing and prices. ${data.forecast.unknownCalls} unconfirmed index calls are excluded. This scales accumulated index/embedding work, including retries and rebuilds; it is not a clean one-build benchmark or a query-cost forecast.`,
        ),
      );
      const breakdown = details(
        "Detailed spending, daily history & 50× scenario",
        columns,
        trends,
        forecast,
      );
      breakdown.classList.add("cost-detail-disclosure");
      content.replaceChildren(stats, sampleNote, providers, ribbon);
      renderLedger(content, data);
      content.append(breakdown);
      const accounting = panel("What these numbers mean");
      accounting.classList.add("cost-accounting");
      accounting.append(
        el(
          "p",
          "cost-note",
          "Known cost is calculated from recorded provider usage and the stored price snapshot, or a recorded service charge. It is not a reconciled provider invoice. Unknown prices stay outside dollar totals; errors can still incur charges. Tokens with missing usage are excluded from token totals. Hosting, subscriptions and human time are not included.",
        ),
      );
      content.append(accounting);
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
function renderLedger(content: HTMLElement, data: CostDashboard) {
  const controls = el("div", "cost-controls");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search operation IDs or activity…";
  search.setAttribute("aria-label", "Search recorded operations");
  const kind = el("select");
  kind.setAttribute("aria-label", "Filter activity type");
  for (const value of ["all", ...new Set(data.runs.map((run) => run.kind))]) {
    const option = el(
      "option",
      "",
      value === "all" ? "All activity" : activityLabel(value),
    );
    option.value = value;
    kind.append(option);
  }
  const state = el("select");
  state.setAttribute("aria-label", "Filter cost status");
  for (const [value, label] of [
    ["all", "All cost states"],
    ["priced", "Fully priced"],
    ["unknown", "Unconfirmed charges"],
    ["failed", "Failed operations"],
  ]) {
    const option = el("option", "", label);
    option.value = value;
    state.append(option);
  }
  controls.append(el("h2", "", "Operation ledger"), search, kind, state);
  const subtotal = el("p", "cost-note");
  const rows = el("div", "cost-ledger");
  content.append(controls, subtotal, rows);
  function render() {
    const query = search.value.toLowerCase().trim();
    const selected = data.runs.filter(
      (run) =>
        (kind.value === "all" || kind.value === run.kind) &&
        (state.value === "all" ||
          (state.value === "priced" && run.receipt.unknownCalls === 0) ||
          (state.value === "unknown" && run.receipt.unknownCalls > 0) ||
          (state.value === "failed" &&
            ["failed", "error"].includes(run.status))) &&
        [
          run.id,
          run.kind,
          run.question ?? "",
          ...run.childRuns.map((child) => child.question ?? child.id),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
    );
    subtotal.textContent = `${selected.length} shown / ${data.totalRootRuns} total root operations · ${money(selected.reduce((sum, run) => sum + run.receipt.knownCostUsd, 0))} known subtotal · ${selected.reduce((sum, run) => sum + run.receipt.unknownCalls, 0)} unconfirmed calls. Latest 100 roots available; child calls are included once.`;
    rows.replaceChildren();
    for (const run of selected) {
      const row = el("details", "cost-ledger-row");
      const summary = el("summary", "cost-ledger-summary");
      const identity = el("div", "cost-identity");
      identity.append(
        el("strong", "", activityTitle(run.kind, run.question, run.id)),
        el(
          "small",
          "",
          `${run.id.slice(0, 8)} · ${activityLabel(run.kind)}${run.childRuns.length ? ` · ${run.childRuns.length} child operations` : ""}`,
        ),
      );
      const stamp = el(
        "time",
        "",
        new Date(run.startedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      stamp.dateTime = run.startedAt;
      const amount = el(
        "strong",
        "cost-ledger-amount",
        `${money(run.receipt.knownCostUsd)}${run.receipt.unknownCalls ? " + ?" : ""}`,
      );
      summary.append(
        identity,
        stamp,
        badge(
          run.status,
          ["failed", "error"].includes(run.status) ? "danger" : "",
        ),
        el("span", "", `${run.receipt.calls} calls`),
        amount,
      );
      const body = el("div", "cost-ledger-body");
      row.addEventListener("toggle", () => {
        if (!row.open || body.childElementCount) return;
        body.append(costReceipt(run.receipt, "Operation receipt"));
        for (const child of run.childRuns)
          body.append(
            el(
              "p",
              "cost-note",
              `Included: ${activityTitle(child.kind, child.question, child.id)}`,
            ),
          );
      });
      row.append(summary, body);
      rows.append(row);
    }
    if (!selected.length)
      rows.append(
        empty(
          "No matching operations",
          "Try another search or filter. New activity appears after a provider operation is recorded.",
        ),
      );
  }
  search.addEventListener("input", render);
  kind.addEventListener("change", render);
  state.addEventListener("change", render);
  render();
}
