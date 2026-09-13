import type { AnswerResult } from "../../../src/contracts.js";
import { badge, el } from "../../shared/dom.js";
import { date } from "../../shared/source-date.js";
import {
  citationSegments,
  navigateCitation,
} from "../answer-sources/citation-navigation.js";
import { sourceCards } from "../answer-sources/source-cards.js";
import { costReceipt } from "../costs/cost-receipt.js";
import { trustScore } from "../trust-score/trust-score.js";
import { verificationChecks } from "../verification/verification-checks.js";
import { requestError } from "../request-error/request-error.js";
export function answerView(answer: AnswerResult, scope: string): HTMLElement {
  const grid = el("div", "answer-layout");
  const left = el("div", "answer-main");
  grid.append(left);
  if (answer.status === "error") {
    left.append(
      requestError(answer.error || answer.text),
      costReceipt(answer.receipt),
    );
    return grid;
  }
  const card = el("article", "answer-card");
  const meta = el("div", "answer-meta");
  meta.append(
    badge(
      answer.status === "answered"
        ? "Answer found"
        : answer.status === "partial"
          ? "Partial answer"
          : "No reliable answer",
      answer.status === "answered" ? "success" : "warning",
    ),
    badge(
      answer.asOf ? `As of ${date(answer.asOf)}` : "Fact date not established",
    ),
  );
  card.append(meta);
  const numbers = new Map(
    answer.sources.map((source, i) => [source.id, i + 1]),
  );
  const content = el("div", "answer-prose");
  for (const paragraph of answer.text.split(/\n\s*\n/)) {
    const p = el("p");
    for (const segment of citationSegments(paragraph, [...numbers.keys()])) {
      if (segment.id !== undefined) {
        const number = numbers.get(segment.id)!;
        const citation = el("button", "citation", String(number));
        citation.type = "button";
        citation.setAttribute("aria-label", `Read source ${number}`);
        citation.addEventListener("click", () =>
          navigateCitation(scope, segment.id!),
        );
        p.append(citation);
      } else p.append(document.createTextNode(segment.text));
    }
    content.append(p);
  }
  card.append(
    content,
    el("p", "answer-footnote", `Source collection ${answer.corpusVersion}`),
  );
  left.append(
    card,
    trustScore(answer.trust),
    verificationChecks(answer.checks),
    costReceipt(answer.receipt),
  );
  grid.append(sourceCards(answer.sources, scope));
  return grid;
}
