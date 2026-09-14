import type { Claim, CheckResult, EvidencePassage } from "../../contracts.js";
import { resolveClaimDate } from "./claim-date.js";
export function numbers(text: string): string[] {
  const commaDecimal = /[\u0400-\u04ff]/u.test(text);
  return (text.match(/\d+(?:[ ,\u00a0\u202f]\d{3})*(?:[.,]\d+)?/g) ?? [])
    .map((token) => {
      let normalized = token.replace(/[ \u00a0\u202f]/g, "");
      if (normalized.includes(",")) {
        const grouping =
          !commaDecimal &&
          !/^0,/.test(normalized) &&
          /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(normalized);
        normalized = grouping
          ? normalized.replaceAll(",", "")
          : normalized.replace(",", ".");
      }
      return Number(normalized);
    })
    .filter(Number.isFinite)
    .map(String);
}
/** Local checks only: citation membership, number grounding, and date provenance. */
export function verifyAnswer(
  claims: Claim[],
  registry: Map<string, EvidencePassage>,
  question: string,
): CheckResult[] {
  return claims.flatMap((claim, index) => {
    const sources = claim.citations.map((id) => registry.get(id));
    const citations = claim.citations.length > 0 && sources.every(Boolean);
    const text = sources
      .filter(Boolean)
      .map(
        (s) =>
          `${s!.text} ${s!.publishedAt ?? ""} ${s!.updatedAt ?? ""} ${s!.fetchedAt}`,
      )
      .join("\n");
    const known = new Set(numbers(text));
    const missing = numbers(claim.text).filter((n) => !known.has(n));
    const date = resolveClaimDate(claim, registry);
    return [
      {
        rule: `claim-${index + 1}:citations`,
        status: citations ? "passed" : "failed",
        reason: citations
          ? "All references were returned in this run"
          : "Missing or invented reference",
      },
      {
        rule: `claim-${index + 1}:quantities`,
        status: missing.length ? "failed" : "passed",
        reason: missing.length
          ? `Unsupported quantities: ${missing.join(", ")}`
          : "Quantities occur in cited evidence; semantic scope still requires review",
      },
      {
        rule: `claim-${index + 1}:date`,
        status: date ? "passed" : "failed",
        reason: date
          ? `Date matches ${date.basis} evidence in ${date.sourceId}; semantic verifier checks its applicability`
          : `Unsupported as-of date. Copy a cited source date: ${sources
              .filter(Boolean)
              .flatMap((source) => [
                source!.publishedAt,
                source!.updatedAt,
                source!.fetchedAt,
              ])
              .filter(Boolean)
              .map((value) => value!.slice(0, 10))
              .join(", ")}; qualify fetched dates as page observations`,
      },
    ] satisfies CheckResult[];
  });
}
