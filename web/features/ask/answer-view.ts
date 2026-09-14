import type { AnswerResult } from "../../../src/contracts.js";
import {
  commonEffectiveDate,
  renderDatedClaims,
} from "../../../src/services/answer/claim-date.js";
import { badge, el } from "../../shared/dom.js";
import { date } from "../../shared/source-date.js";
import {
  citationSegments,
  navigateCitation,
  groupSources,
} from "./citation-navigation.js";
import { sourceCards } from "./source-cards.js";
import { costReceipt } from "../costs/cost-receipt.js";
import { trustScore } from "./trust-score.js";
import { verificationChecks } from "./verification-checks.js";
import { requestError } from "./request-error.js";
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
  const header = el("header", "answer-header");
  const heading = el("div", "answer-heading");
  heading.append(
    el("p", "eyebrow", "Corpus-grounded answer"),
    el(
      "h2",
      "",
      answer.status === "no_reliable_answer"
        ? "No reliable answer found"
        : answer.status === "partial"
          ? "What the evidence supports"
          : "What the sources say",
    ),
  );
  header.append(heading);
  left.append(header);
  const summary = el("div", "answer-summary");
  summary.setAttribute("aria-label", "Answer evidence summary");
  const stats = [
    [String(answer.claims.length), "Answer claims"],
    [String(groupSources(answer.sources).length), "Cited pages"],
    [
      answer.trust ? `${answer.trust.score} / 100` : "Unavailable",
      "Evidence score",
    ],
    [String(answer.receipt.calls), "Model calls"],
  ];
  for (const [value, label] of stats) {
    const stat = el("div", "answer-stat");
    stat.append(el("strong", "", value), el("span", "", label));
    summary.append(stat);
  }
  left.append(summary);
  const card = el("article", `answer-card answer-${answer.status}`);
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
      commonEffectiveDate(answer.claims)
        ? `As of ${date(commonEffectiveDate(answer.claims))}`
        : answer.claims.length
          ? "Dates shown per claim"
          : "Fact date not established",
    ),
  );
  meta.append(
    el(
      "span",
      "answer-date-note",
      "Fact dates belong to each claim; collection dates belong to the sources.",
    ),
  );
  card.append(meta);
  const numbers = new Map(
    answer.sources.map((source, i) => [source.id, i + 1]),
  );
  const content = el("div", "answer-prose");
  const datedText = answer.claims.length
    ? renderDatedClaims(answer.claims, answer.sources)
    : answer.text;
  for (const paragraph of datedText.split(/\n\s*\n/)) {
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
