import type { EvidencePassage } from "../../../src/contracts.js";
export function passageAnchor(scope: string, id: string): string {
  return `${scope}-passage-${encodeURIComponent(id)}`;
}
export function groupSources(sources: EvidencePassage[]): EvidencePassage[][] {
  const groups = new Map<string, EvidencePassage[]>();
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    const key = source.documentId || source.url.split("#")[0];
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function navigateCitation(scope: string, id: string): void {
  const passage = document.getElementById(passageAnchor(scope, id));
  if (!passage) return;
  let parent: HTMLElement | null = passage.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  document
    .querySelectorAll(".passage.highlighted")
    .forEach((node) => node.classList.remove("highlighted"));
  passage.classList.add("highlighted");
  passage.focus({ preventScroll: true });
  passage.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "center",
  });
}

/** Match complete registered markers, including punctuation inside an arbitrary evidence ID. */
export function citationSegments(
  text: string,
  ids: string[],
): Array<{ text: string; id?: string }> {
  if (!ids.length) return [{ text }];
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    ids
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((id) => escape(`[${id}]`))
      .join("|"),
    "g",
  );
  const result: Array<{ text: string; id?: string }> = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset)
      result.push({ text: text.slice(offset, match.index) });
    result.push({ text: match[0], id: match[0].slice(1, -1) });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) result.push({ text: text.slice(offset) });
  return result;
}
