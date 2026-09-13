import type { DocumentSnapshot } from "../../../src/contracts.js";
import {
  badge,
  button,
  details,
  el,
  empty,
  getJson,
  link,
  metric,
} from "../../shared/dom.js";
import { authority, date } from "../../shared/source-date.js";
interface CorpusPage {
  version: string;
  total: number;
  documents: DocumentSnapshot[];
  pageSize?: number;
  hasNext?: boolean;
  events?: Array<Record<string, unknown>>;
}
export function corpusPage(): HTMLElement {
  const page = el("section", "explore-page");
  page.append(
    el("p", "eyebrow", "THE SOURCE COLLECTION"),
    el("h1", "", "See what the assistant knows."),
    el(
      "p",
      "lede",
      "Browse collected pages, inspect their dates, and see where the evidence comes from.",
    ),
  );
  const results = el("div");
  const controls = el("div", "section-heading");
  const label = el("span", "muted");
  let currentPage = 0;
  let generation = 0;
  const previous = button("← Previous", () => {
    currentPage--;
    void load();
  });
  const next = button("Next →", () => {
    currentPage++;
    void load();
  });
  controls.append(previous, label, next);
  page.append(
    results,
    controls,
    operatorRefresh(() => void load()),
  );
  async function load() {
    const request = ++generation;
    results.replaceChildren(el("p", "muted", "Loading collected pages…"));
    previous.disabled = true;
    next.disabled = true;
    try {
      const data = await getJson<CorpusPage>(`/api/corpus?page=${currentPage}`);
      if (request !== generation) return;
      const stats = el("div", "metrics");
      stats.append(
        metric("Collected pages", data.total.toLocaleString()),
        metric("Collection version", data.version || "Not published"),
      );
      results.replaceChildren(stats);
      if (!data.documents.length)
        results.append(
          empty(
            "No pages to show",
            "A source collection has not been published for this page yet.",
          ),
        );
      const list = el("div", "corpus-grid");
      for (const doc of data.documents) {
        const card = el("article", "document-card");
        const head = el("div", "answer-meta");
        head.append(badge(authority(doc.authority)), badge(doc.kind));
        if (doc.duplicateOf) head.append(badge("Duplicate", "warning"));
        const title = el("h3");
        title.append(link(doc.title || doc.url, doc.url));
        card.append(
          head,
          title,
          el("p", "source-publisher", doc.publisher),
          el(
            "p",
            "small muted",
            doc.publishedAt
              ? `Published ${date(doc.publishedAt)}`
              : "Publication date unknown",
          ),
        );
        if (doc.updatedAt)
          card.append(el("p", "small muted", `Updated ${date(doc.updatedAt)}`));
        card.append(
          el("p", "small muted", `Checked ${date(doc.fetchedAt)}`),
          details(
            "Read collected excerpt",
            el("p", "document-excerpt", doc.text || "No text is available."),
            el(
              "p",
              "small muted",
              "This is a preview of the saved page, not the complete document.",
            ),
          ),
        );
        const url = link(doc.url, doc.url);
        url.classList.add("source-url");
        card.append(url);
        list.append(card);
      }
      results.append(list);
      label.textContent = `Page ${currentPage + 1} · ${data.total} pages collected`;
      previous.disabled = currentPage === 0;
      next.disabled = !(
        data.hasNext ?? (currentPage + 1) * (data.pageSize ?? 50) < data.total
      );
      // Pagination uses server metadata; the collection total is not the page count.
      if (data.events?.length) {
        const history = el("div", "change-history");
        for (const event of data.events.slice(0, 30)) {
          const row = el("article", "collection-event");
          row.append(
            badge(String(event.status ?? "Checked").replaceAll("_", " ")),
          );
          if (typeof event.url === "string")
            row.append(link(event.url, event.url));
          if (typeof event.reason === "string")
            row.append(el("p", "small muted", event.reason));
          if (typeof event.checked_at === "string")
            row.append(
              el("p", "small muted", `Checked ${date(event.checked_at)}`),
            );
          history.append(row);
        }
        results.append(details("Recent collection activity", history));
      }
    } catch (error) {
      if (request === generation)
        results.replaceChildren(
          empty("Collection unavailable", (error as Error).message),
          button("Try again", () => void load()),
        );
    }
  }
  void load();
  return page;
}
function operatorRefresh(refreshed: () => void): HTMLElement {
  const form = el("form", "operator-form");
  const token = el("input");
  token.type = "password";
  token.autocomplete = "off";
  token.id = "operator-token";
  token.required = true;
  const tokenLabel = el("label", "", "Operator access token");
  tokenLabel.htmlFor = token.id;
  const source = el("input");
  source.id = "refresh-source";
  source.placeholder = "Leave blank to check all sources";
  const sourceLabel = el("label", "", "Source ID (optional)");
  sourceLabel.htmlFor = source.id;
  const submit = el("button", "button secondary", "Check sources for updates");
  submit.type = "submit";
  const feedback = el("p", "small");
  feedback.setAttribute("role", "status");
  form.append(
    el(
      "p",
      "muted small",
      "For the collection operator. Checking sources can use paid services. Your token is sent with this request and is not saved.",
    ),
    tokenLabel,
    token,
    sourceLabel,
    source,
    submit,
    feedback,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    feedback.textContent = "Checking sources…";
    const credential = token.value.trim();
    token.value = "";
    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(
          source.value.trim() ? { sourceId: source.value.trim() } : {},
        ),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error || `Update request failed (${response.status}).`,
        );
      }
      feedback.textContent =
        "The source check has finished. The collection view is being refreshed.";
      refreshed();
    } catch (error) {
      feedback.textContent = (error as Error).message;
    } finally {
      submit.disabled = false;
    }
  });
  return details("Operator · update the collection", form);
}
