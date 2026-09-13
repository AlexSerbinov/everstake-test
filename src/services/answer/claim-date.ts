import type { Claim, EvidencePassage } from "../../contracts.js";

export interface ClaimDate {
  date: string;
  basis: NonNullable<Claim["asOfBasis"]>;
  sourceId: string;
}

function calendarDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Metadata proves a document date, never the effective date of every fact on it. */
export function resolveClaimDate(
  claim: Claim,
  registry: Map<string, EvidencePassage>,
): ClaimDate | null {
  if (!claim.asOf || !calendarDate(claim.asOf)) return null;
  const date = claim.asOf;
  const sources = claim.citations
    .map((id) => registry.get(id))
    .filter(
      (s): s is EvidencePassage =>
        !!s && (!claim.asOfSource || s.id === claim.asOfSource),
    );
  // Legacy claims get a conservative document-date attribution, not an invented fact date.
  const bases = claim.asOfBasis
    ? ([claim.asOfBasis] as const)
    : (["published", "updated", "observed", "effective"] as const);
  for (const basis of bases) {
    for (const source of sources) {
      const matches =
        basis === "effective"
          ? new RegExp(`(?<![\\d-])${date}(?![\\d-])`).test(source.text)
          : (basis === "published"
              ? source.publishedAt
              : basis === "updated"
                ? source.updatedAt
                : source.fetchedAt
            )?.slice(0, 10) === date;
      if (matches) return { date, basis, sourceId: source.id };
    }
  }
  return null;
}

export function normalizeClaimDate(
  claim: Claim,
  registry: Map<string, EvidencePassage>,
): Claim {
  const resolved = resolveClaimDate(claim, registry);
  return resolved
    ? { ...claim, asOfBasis: resolved.basis, asOfSource: resolved.sourceId }
    : claim;
}

/** Shared by API/CLI text and the UI, including old saved answers without inline dates. */
export function renderDatedClaims(
  claims: Claim[],
  sources: EvidencePassage[],
): string {
  const registry = new Map(sources.map((s) => [s.id, s]));
  return claims
    .map((claim) => {
      const resolved = resolveClaimDate(claim, registry);
      const citations = claim.citations.map((id) => `[${id}]`).join(" ");
      const scope =
        claim.temporalScope === "cumulative"
          ? "Cumulative total across time, not a previous simultaneous count. "
          : "";
      if (!resolved)
        return `${claim.text} ${citations} (Fact date not established.)`;
      const label = {
        effective: "Fact as of",
        published: registry.get(resolved.sourceId)?.metadata.videoId
          ? "Source uploaded"
          : "Source published",
        updated: "Source updated",
        observed: "Page checked",
      }[resolved.basis];
      const limit =
        resolved.basis === "effective"
          ? ""
          : "; fact effective date not established";
      const source = registry.get(resolved.sourceId)!;
      const publication =
        resolved.basis !== "published" && source.publishedAt
          ? `; source ${source.metadata.videoId ? "uploaded" : "published"} ${source.publishedAt.slice(0, 10)}`
          : "";
      return `${scope}${claim.text} ${citations} (${label} ${resolved.date}${publication} [${resolved.sourceId}]${limit}.)`;
    })
    .join("\n\n");
}

/** A mixed timeline cannot acquire one current date from its newest citation. */
export function commonEffectiveDate(claims: Claim[]): string | null {
  const first = claims[0]?.asOf;
  return first &&
    claims.every((c) => c.asOf === first && c.asOfBasis === "effective")
    ? first
    : null;
}
