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
  const title = el("h3");
  title.append(link(source.title || source.url, source.url));
  card.append(
    title,
    el(
      "p",
      "source-publisher",
      `${source.publisher} · ${authority(source.authority)}`,
    ),
  );
  const dates = el("div", "source-dates");
  dates.append(
    el(
      "span",
      "",
      source.publishedAt
        ? `Published ${date(source.publishedAt)}`
        : "Publication date unknown",
    ),
  );
  if (source.updatedAt)
    dates.append(el("span", "", `Updated ${date(source.updatedAt)}`));
  dates.append(el("span", "", `Checked ${date(source.fetchedAt)}`));
  card.append(dates);
  for (const passage of passages) {
    const block = el("section", "passage");
    block.id = passageAnchor(scope, passage.id);
    block.tabIndex = -1;
    block.append(badge(`${numbers.get(passage.id) ?? "•"}`, "citation-number"));
    // Exact registered evidence is retained; a preview never invents surrounding context.
    const quote = el(
      "blockquote",
      "",
      passage.text.length > 650
        ? `${passage.text.slice(0, 650)}…`
        : passage.text,
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
    const meta = el("div", "source-meta");
    meta.append(el("p", "", `Evidence reference: ${passage.id}`));
    if (passage.reason)
      meta.append(el("p", "", `Selection note: ${passage.reason}`));
    block.append(details("About this passage", meta));
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
  heading.append(el("h2", "", "Sources"), badge(`${groups.length} pages`));
  pane.append(heading);
  pane.append(
    el(
      "p",
      "muted small",
      "Passages cited in this answer. Checked dates record when a page was read, not when every fact became true.",
    ),
  );
  const numbers = new Map(sources.map((source, i) => [source.id, i + 1]));
  for (const group of groups) pane.append(sourceCard(group, numbers, scope));
  if (!sources.length) pane.append(el("p", "muted", "No sources were cited."));
  return pane;
}
