import { el, link } from "../../shared/dom.js";

/** A deliberately small Markdown subset: headings, paragraphs, lists and links. No HTML. */
export function renderDocument(markdown: string): HTMLElement {
  const article = el("article", "finding-document");
  for (const block of markdown.trim().split(/\n\s*\n/)) {
    const heading = /^(#{1,3}) (.+)$/.exec(block);
    if (heading) {
      const level = heading[1].length;
      article.append(
        el(level === 1 ? "h1" : level === 2 ? "h2" : "h3", "", heading[2]),
      );
    } else if (block.split("\n").every((line) => line.startsWith("- "))) {
      const list = el("ul");
      for (const line of block.split("\n")) {
        const item = el("li");
        appendInline(item, line.slice(2));
        list.append(item);
      }
      article.append(list);
    } else {
      const paragraph = el("p");
      appendInline(paragraph, block.replace(/\n/g, " "));
      article.append(paragraph);
    }
  }
  return article;
}

function appendInline(node: HTMLElement, text: string) {
  let offset = 0;
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^\s)]+)\)/g)) {
    node.append(document.createTextNode(text.slice(offset, match.index)));
    node.append(link(match[1], match[2]));
    offset = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(offset)));
}
