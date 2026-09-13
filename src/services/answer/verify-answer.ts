import type { Claim, CheckResult, EvidencePassage } from "../../contracts.js";
export function numbers(text: string): string[] {
  return (
    text.replace(/(\d)[ ,](?=\d{3}(?:\D|$))/g, "$1").match(/\d+(?:\.\d+)?/g) ??
    []
  ).map((n) => String(Number(n)));
}
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
    const date = !!claim.asOf && text.includes(claim.asOf);
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
          ? "Date is present in evidence; semantic verifier checks its meaning"
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
