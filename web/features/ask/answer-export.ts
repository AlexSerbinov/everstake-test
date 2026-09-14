import type { AnswerResult } from "../../../src/contracts.js";
import { renderDatedClaims } from "../../../src/services/answer/claim-date.js";
import { safeUrl } from "../../shared/dom.js";

/** Export the same dated claims shown in the UI, with resolvable source IDs. */
export function answerText(question: string, answer: AnswerResult): string {
  const content = answer.claims.length
    ? renderDatedClaims(answer.claims, answer.sources)
    : answer.text;
  const sources = answer.sources.map(
    (source) =>
      `[${source.id}] ${source.title}\n${safeUrl(source.url) ?? "Source URL unavailable"}`,
  );
  return `${question}\n\n${content}\n\nStatus: ${answer.status}\nSource collection: ${answer.corpusVersion}\n\nSources\n${sources.join("\n\n")}`;
}
