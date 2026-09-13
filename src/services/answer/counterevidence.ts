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
  /\b(always|never|every|all|any|must|mandatory|compulsory|obligatory|required|guaranteed?|only|cannot|unconditional(?:ly)?|not optional|non-optional|no exceptions?|without exception|in all cases|in every case|regardless)\b|(?:завжди|ніколи|кожн[а-яіїєґ]*|усі|всі|будь-як[а-яіїєґ]*|обов[’']язков[а-яіїєґ]*|гарант[а-яіїєґ]*|лише|тільки|виключно|неможливо|не може|не можуть|миттєво|негайно|немає інформації)/iu;
const EXCEPTION_TERMS =
  "optional exception except unless alternative without free waived not required can also";

const STOPWORDS = new Set(
  "the and for with that this from into over under than then also are was were has have had not non its his her their our your they them been being page checked according documentation".split(
    " ",
  ),
);

/**
 * The exception query is built around the absolute term itself: the few content words next to
 * it name the subject (the tip, the key, the region), and the exception vocabulary asks for
 * the passages that limit it. Searching the whole claim would return the pages that repeat
 * the rule rather than the ones that qualify it.
 */
export function exceptionQuery(text: string): string {
  const match = ABSOLUTE_WORDING.exec(text);
  const at = match?.index ?? 0;
  const window = text.slice(
    Math.max(0, at - 80),
    at + (match?.[0].length ?? 0) + 80,
  );
  const words = [
    ...new Set(
      (window.match(/[\p{L}\p{N}-]{3,}/gu) ?? [])
        .map((w) => w.toLowerCase())
        .filter(
          (w) =>
            !STOPWORDS.has(w) &&
            !ABSOLUTE_WORDING.test(w) &&
            !/^\d{4}-\d{2}/.test(w),
        ),
    ),
  ].slice(0, 8);
  return `${words.join(" ")} ${EXCEPTION_TERMS}`;
}

export interface ClaimCounterevidence {
  claimIndex: number;
  newer: EvidencePassage[];
  exceptions: EvidencePassage[];
  /** Same-subject evidence can differ in scope without having a newer timestamp. */
  related?: EvidencePassage[];
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
  perClaim = 3,
  question = "",
): Promise<ClaimCounterevidence[]> {
  const results: ClaimCounterevidence[] = [];
  // Searching only a proposed answer can confirm its framing while missing the
  // user's requested state. Keep question-led evidence in the review as well.
  const requested = question ? await search(question, 10) : [];
  // Searches run one after another: each scans the corpus vectors, and parallel scans
  // multiply peak memory on the small demo host.
  for (const [claimIndex, claim] of claims.entries()) {
    {
      const cited = claim.citations
        .map((id) => registry.get(id))
        .filter((s): s is EvidencePassage => !!s);
      const subject = [
        ...new Map(
          [...requested, ...(await search(claim.text, 10))].map((s) => [
            s.id,
            s,
          ]),
        ).values(),
      ];
      const exceptions = ABSOLUTE_WORDING.test(claim.text)
        ? await search(exceptionQuery(claim.text), 12)
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
        related: subject.filter((s) => !seen.has(s.id)).slice(0, perClaim),
        exceptions: exceptions
          .filter((s) => !seen.has(s.id))
          .slice(0, perClaim),
      });
    }
  }
  return results;
}
