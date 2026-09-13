import type { DocumentSnapshot } from "../../../src/contracts.js";
import type { browseCorpus } from "../../../src/services/corpus/browse-corpus.js";
import {
  badge,
  button,
  details,
  el,
  empty,
  getJson,
  link,
} from "../../shared/dom.js";
import { authority, date } from "../../shared/source-date.js";
type CorpusPage = ReturnType<typeof browseCorpus>;

export function corpusPage(): HTMLElement {
  const page = el("section", "explore-page corpus-page");
  page.append(
    el("p", "eyebrow", "THE SOURCE COLLECTION"),
    el("h1", "", "Explore the corpus."),
    el(
      "p",
      "lede",
      "Find a document, check its dates and open the saved evidence. Browse 100 documents at a time.",
    ),
  );
  const summary = el("div", "corpus-summary");
  const filters = el("form", "corpus-filters");
  const queryLabel = el("label", "corpus-search", "Search the collection");
  const query = el("input");
  query.type = "search";
  query.maxLength = 200;
  query.placeholder = "Title, publisher, URL or content…";
  queryLabel.append(query);
  const kindLabel = el("label", "", "Source type");
  const kind = el("select");
  kind.append(new Option("All types", ""));
  kindLabel.append(kind);
  const copiesLabel = el("label", "", "Copies");
  const copies = el("select");
  copies.append(
    new Option("All documents", ""),
    new Option("Hide marked copies", "hide"),
    new Option("Marked copies only", "only"),
  );
  copiesLabel.append(copies);
  const submit = el("button", "button primary", "Search");
  submit.type = "submit";
  const clear = button("Reset", () => {
    query.value = "";
    kind.value = "";
    copies.value = "";
    currentPage = 0;
    void load();
  });
  filters.append(queryLabel, kindLabel, copiesLabel, submit, clear);
  const count = el("p", "small muted corpus-results-count");
  count.setAttribute("role", "status");
  const results = el("div", "corpus-results");
  let currentPage = 0;
  let generation = 0;
  let initialized = false;
  const pagers: Array<{
    previous: HTMLButtonElement;
    next: HTMLButtonElement;
    label: HTMLElement;
  }> = [];
  function pager() {
    const navigation = el("nav", "corpus-pagination");
    navigation.setAttribute("aria-label", "Document pages");
    const previous = button("← Previous", () => {
      currentPage--;
      void load(true);
    });
    const next = button("Next →", () => {
      currentPage++;
      void load(true);
    });
    const label = el("span", "small muted");
    pagers.push({ previous, next, label });
    navigation.append(previous, label, next);
    return navigation;
  }
  const history = el("div");
  page.append(summary, filters, count, pager(), results, pager(), history);
  const updates = el("a", "text-button", "Update this collection →");
  updates.href = "#updates";
  page.append(updates);
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    currentPage = 0;
    void load();
  });
  for (const select of [kind, copies])
    select.addEventListener("change", () => {
      currentPage = 0;
      void load();
    });

  async function load(scroll = false) {
    const request = ++generation;
    pagers.forEach((p) => {
      p.previous.disabled = true;
      p.next.disabled = true;
    });
    results.setAttribute("aria-busy", "true");
    count.textContent = "Searching the collection…";
    const params = new URLSearchParams({
      page: String(currentPage),
      q: query.value.trim(),
      kind: kind.value,
      copies: copies.value,
    });
    try {
      const data = await getJson<CorpusPage>(`/api/corpus?${params}`);
      if (request !== generation) return;
      currentPage = data.page;
      if (!initialized) {
        data.kinds.forEach((item) =>
          kind.append(new Option(`${item.kind} (${item.count})`, item.kind)),
        );
        initialized = true;
      }
      summary.replaceChildren(
        el("strong", "", `${data.collectionTotal.toLocaleString()} documents`),
        el("span", "", `${data.duplicateCount} marked copies`),
        el("span", "small muted", `Collection ${data.version}`),
      );
      const start = data.total ? currentPage * data.pageSize + 1 : 0;
      const end = Math.min((currentPage + 1) * data.pageSize, data.total);
      count.textContent = `${start.toLocaleString()}–${end.toLocaleString()} of ${data.total.toLocaleString()} matching documents · ${data.pageSize} per page`;
      pagers.forEach((p) => {
        p.previous.disabled = currentPage === 0;
        p.next.disabled = !data.hasNext;
        p.label.textContent = data.total
          ? `Page ${currentPage + 1} of ${data.pageCount}`
          : "No matching documents";
      });
      const table = el("table", "corpus-table");
      const caption = el(
        "caption",
        "sr-only",
        "Collected documents and source dates",
      );
      const thead = el("thead");
      const head = el("tr");
      for (const label of [
        "Document",
        "Type / authority",
        "Source dates",
        "Evidence",
      ]) {
        const th = el("th", "", label);
        th.scope = "col";
        head.append(th);
      }
      thead.append(head);
      const body = el("tbody");
      data.documents.forEach((doc, index) =>
        appendDocument(body, doc, `corpus-${request}-${index}`),
      );
      table.append(caption, thead, body);
      results.replaceChildren(
        data.documents.length
          ? table
          : empty(
              "No matching documents",
              "Try a different search or reset the filters.",
            ),
      );
      history.replaceChildren();
      if (data.events.length) {
        const events = el("div", "change-history");
        for (const event of data.events) {
          const row = el("article", "collection-event");
          row.append(badge(String(event.status).replaceAll("_", " ")));
          if (typeof event.url === "string")
            row.append(link(event.url, event.url));
          if (typeof event.reason === "string")
            row.append(el("p", "small muted", event.reason));
          events.append(row);
        }
        history.append(details("Recent collection activity", events));
      }
      if (scroll)
        filters.scrollIntoView({ block: "start", behavior: "instant" });
    } catch (error) {
      if (request !== generation) return;
      count.textContent = "Collection could not be loaded.";
      results.replaceChildren(
        empty("Collection unavailable", (error as Error).message),
        button("Try again", () => void load()),
      );
    } finally {
      if (request === generation) results.removeAttribute("aria-busy");
    }
  }
  void load();
  return page;
}

function appendDocument(
  body: HTMLTableSectionElement,
  doc: DocumentSnapshot,
  id: string,
) {
  const row = el("tr", "corpus-row");
  const title = el("td", "corpus-document");
  title.append(
    link(doc.title || doc.url, doc.url),
    el("span", "small muted", doc.publisher),
  );
  const sourceUrl = link(doc.url, doc.url);
  sourceUrl.classList.add("corpus-url");
  title.append(sourceUrl);
  const type = el("td", "corpus-type");
  type.append(
    badge(doc.kind),
    el("span", "small muted", authority(doc.authority)),
  );
  if (doc.duplicateOf) type.append(badge("Marked copy", "warning"));
  const dates = el("td", "corpus-dates small");
  dates.append(
    el(
      "span",
      "",
      doc.publishedAt
        ? `${doc.kind === "youtube" ? "Uploaded" : "Published"} ${date(doc.publishedAt)}`
        : "Publication date unknown",
    ),
    el("span", "muted", `Checked ${date(doc.fetchedAt)}`),
  );
  if (doc.updatedAt)
    dates.append(el("span", "muted", `Updated ${date(doc.updatedAt)}`));
  const action = el("td", "corpus-action");
  const expanded = el("tr", "corpus-expanded");
  expanded.id = id;
  expanded.hidden = true;
  const detail = el("td");
  detail.colSpan = 4;
  detail.append(
    el("p", "eyebrow", "SAVED EXCERPT"),
    el("p", "document-excerpt", doc.text || "No text is available."),
    el(
      "p",
      "small muted",
      "Preview of the saved document. Checked dates record collection, not when every fact became true.",
    ),
  );
  if (doc.duplicateOf)
    detail.append(
      el(
        "p",
        "small muted",
        `Marked as a copy of document ${doc.duplicateOf}. Both source URLs are retained for traceability.`,
      ),
    );
  expanded.append(detail);
  const toggle = button(
    "Read excerpt",
    () => {
      expanded.hidden = !expanded.hidden;
      toggle.setAttribute("aria-expanded", String(!expanded.hidden));
      toggle.textContent = expanded.hidden ? "Read excerpt" : "Close excerpt";
    },
    "text-button",
  );
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", id);
  action.append(toggle);
  row.append(title, type, dates, action);
  body.append(row, expanded);
}
