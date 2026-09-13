import type { Claim, EvidencePassage } from "../../contracts.js";

/**
 * Before a draft claim is verified, the corpus is searched again for evidence that could
 * override it. Two generic cases are covered without naming any entity or fact:
 *  - newer passages of equal or higher authority on the same subject (a role, a count or a
 *    price stated years ago must not be presented as current when a fresher page differs);
 *  - exceptions and optional paths when the claim uses absolute wording.
 * Retrieval and date comparison are deterministic; whether the passages actually conflict is
 * decided by the support review, which receives them alongside the cited evidence.
 */
export const ABSOLUTE_WORDING =
  /\b(always|never|every|all|any|must|mandatory|required|guaranteed?|only|cannot|unconditional(?:ly)?|no exceptions?|without exception|in all cases)\b/i;
const EXCEPTION_TERMS =
  "optional exception except unless alternative without free waived not required can also";

export interface ClaimCounterevidence {
  claimIndex: number;
  newer: EvidencePassage[];
  exceptions: EvidencePassage[];
}

export function evidenceDate(source: EvidencePassage): string | null {
  return (source.updatedAt ?? source.publishedAt)?.slice(0, 10) ?? null;
}

export function isNewerCandidate(
  claim: Claim,
  cited: EvidencePassage[],
  candidate: EvidencePassage,
): boolean {
  if (claim.citations.includes(candidate.id)) return false;
  const date = evidenceDate(candidate);
  if (!date) return false; // Undated pages cannot prove that a statement is more recent.
  const reference =
    claim.asOf ??
    cited
      .map(evidenceDate)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
  if (!reference || date <= reference.slice(0, 10)) return false;
  const bestCited = Math.min(...cited.map((s) => s.authority), 3);
  return candidate.authority <= bestCited;
}

export async function gatherCounterevidence(
  claims: Claim[],
  registry: Map<string, EvidencePassage>,
  search: (query: string, limit?: number) => Promise<EvidencePassage[]>,
  perClaim = 4,
): Promise<ClaimCounterevidence[]> {
  const results: ClaimCounterevidence[] = [];
  // Searches run one after another: each scans the corpus vectors, and parallel scans
  // multiply peak memory on the small demo host.
  for (const [claimIndex, claim] of claims.entries()) {
    {
      const cited = claim.citations
        .map((id) => registry.get(id))
        .filter((s): s is EvidencePassage => !!s);
      const subject = await search(claim.text, 10);
      const exceptions = ABSOLUTE_WORDING.test(claim.text)
        ? await search(`${claim.text} ${EXCEPTION_TERMS}`, 10)
        : [];
      const newer = subject
        .filter((s) => isNewerCandidate(claim, cited, s))
        .sort((a, b) =>
          (evidenceDate(b) ?? "").localeCompare(evidenceDate(a) ?? ""),
        )
        .slice(0, perClaim);
      const seen = new Set([...claim.citations, ...newer.map((s) => s.id)]);
      results.push({
        claimIndex,
        newer,
        exceptions: exceptions
          .filter((s) => !seen.has(s.id))
          .slice(0, perClaim),
      });
    }
  }
  return results;
}
