import type { EvidencePassage } from "../../../src/contracts.js";
import { badge, details, el, link } from "../../shared/dom.js";
import { authority, date } from "../../shared/source-date.js";
import { groupSources, passageAnchor } from "./citation-navigation.js";
export function sourceCard(
  passages: EvidencePassage[],
  numbers: Map<string, number>,
  scope: string,
): HTMLElement {
  const source = passages[0];
  const card = el("article", `source-card authority-${source.authority}`);
  const heading = el("div", "source-heading");
  const icon = el(
    "span",
    "source-icon",
    source.metadata.videoId ? "VIDEO" : "WEB",
  );
  icon.setAttribute("aria-hidden", "true");
  const identity = el("div", "source-identity");
  const title = el("h3");
  title.append(link(source.title || source.url, source.url));
  identity.append(
    el("p", "source-publisher", source.publisher || "Publisher not recorded"),
    title,
    badge(authority(source.authority), "source-authority"),
  );
  heading.append(icon, identity);
  card.append(heading);
  const dates = el("div", "source-dates");
  dates.append(
    el(
      "span",
      "",
      source.publishedAt
        ? ` ${source.metadata.videoId ? "Uploaded" : "Published"} ${date(source.publishedAt)}`.trim()
        : "Publication date unknown",
    ),
  );
  if (source.updatedAt)
    dates.append(el("span", "", `Updated ${date(source.updatedAt)}`));
  dates.append(el("span", "", `Checked ${date(source.fetchedAt)}`));
  if (source.metadata.videoId)
    dates.append(
      el(
        "span",
        "",
        source.metadata.recordedAt
          ? `Recorded ${date(String(source.metadata.recordedAt))}`
          : "Recording date unknown; upload date may differ",
      ),
    );
  card.append(dates);
  for (const passage of passages) {
    const block = el("section", "passage");
    block.id = passageAnchor(scope, passage.id);
    block.tabIndex = -1;
    block.append(badge(`${numbers.get(passage.id) ?? "•"}`, "citation-number"));
    // Exact registered evidence is retained; a preview never invents surrounding context.
    const quote = el(
      "blockquote",
      "source-excerpt",
      passage.text.length > 650
        ? `${passage.text.slice(0, 650)}…`
        : passage.text,
    );
    if (typeof passage.metadata.startMs === "number")
      block.append(
        el(
          "p",
          "small muted",
          `Video time ${Math.floor(passage.metadata.startMs / 60000)}:${String(Math.floor(passage.metadata.startMs / 1000) % 60).padStart(2, "0")} · speaker review: ${String(passage.metadata.reviewStatus ?? "unknown")}`,
        ),
      );
    block.append(quote);
    const original = link("Open this passage ↗", passage.url);
    original.classList.add("passage-link");
    block.append(original);
    if (passage.text.length > 650)
      block.append(
        details(
          "Read the full passage",
          el("blockquote", "full-passage", passage.text),
        ),
      );
    const meta = el("p", "source-meta small muted");
    meta.textContent = `Ref ${passage.id.slice(0, 8)}${passage.reason ? ` · ${passage.reason}` : ""}`;
    meta.title = `Evidence reference: ${passage.id}`;
    block.append(meta);
    card.append(block);
  }
  const url = link(source.url, source.url);
  url.classList.add("source-url");
  card.append(url);
  return card;
}
export function sourceCards(
  sources: EvidencePassage[],
  scope: string,
): HTMLElement {
  const pane = el("aside", "sources-pane");
  const groups = groupSources(sources);
  const heading = el("div", "section-heading");
  heading.append(
    el("h2", "", "Sources"),
    badge(`${groups.length} ${groups.length === 1 ? "page" : "pages"}`),
  );
  pane.setAttribute("aria-label", "Cited evidence sources");
  pane.append(heading);
  pane.append(
    el(
      "p",
      "muted small",
      "Passages cited in this answer. Checked dates record when a page was read, not when every fact became true.",
    ),
  );
  const numbers = new Map(sources.map((source, i) => [source.id, i + 1]));
  const list = el("div", "source-list");
  for (const group of groups) list.append(sourceCard(group, numbers, scope));
  pane.append(list);
  if (!sources.length) pane.append(el("p", "muted", "No sources were cited."));
  return pane;
}
