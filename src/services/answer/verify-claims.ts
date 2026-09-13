import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  Claim,
  CheckResult,
  EvidencePassage,
  ModelClient,
} from "../../contracts.js";
import { evidenceDate, type ClaimCounterevidence } from "./counterevidence.js";
const schema = z.object({
  questionMode: z.enum(["factual", "synthesis"]),
  checks: z.array(
    z.object({
      claimIndex: z.number().int().nonnegative(),
      supported: z.boolean(),
      supersededByNewer: z.boolean().optional().default(false),
      reason: z.string(),
    }),
  ),
});
export async function verifyClaims(
  model: ModelClient,
  runId: string,
  claims: Claim[],
  registry: Map<string, EvidencePassage>,
  question: string,
  signal?: AbortSignal,
  counterevidence: ClaimCounterevidence[] = [],
): Promise<CheckResult[]> {
  const extra = new Map(counterevidence.map((c) => [c.claimIndex, c]));
  // Counterevidence is compared, not cited, so the reviewer sees a bounded excerpt of each.
  const excerpt = (sources: EvidencePassage[]) =>
    sources.map((s) => ({ ...s, text: s.text.slice(0, 700) }));
  const request = {
    runId,
    signal,
    stage: "claim-verification",
    model: "gemini-3.5-flash-lite",
    system: readFileSync("prompts/verify-claims.md", "utf8"),
    messages: [
      {
        role: "user" as const,
        text: JSON.stringify({
          question,
          otherRetrievedEvidence: [...registry.values()],
          claims: claims.map((claim, claimIndex) => ({
            claimIndex,
            claim,
            evidence: claim.citations.map((id) => registry.get(id)),
            newerEvidence: excerpt(extra.get(claimIndex)?.newer ?? []),
            exceptionEvidence: excerpt(extra.get(claimIndex)?.exceptions ?? []),
          })),
        }),
      },
    ],
    maxOutputTokens: 3000,
  };
  const complete = (result: z.infer<typeof schema>) =>
    result.checks.length === claims.length &&
    new Set(result.checks.map((c) => c.claimIndex)).size === claims.length &&
    result.checks.every((c) => c.claimIndex < claims.length);
  let result: z.infer<typeof schema> | undefined;
  // A malformed review is a provider defect, not evidence about the answer: one metered
  // retry before the question is reported as an error.
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    const response = await model.generate(request);
    try {
      const parsed = schema.parse(
        JSON.parse(
          response.text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
        ),
      );
      if (complete(parsed)) result = parsed;
    } catch {
      /* Retry once; the second failure is reported below. */
    }
  }
  if (!result)
    throw new Error("Verifier did not assess every claim exactly once");
  const checks: CheckResult[] = result.checks.flatMap((c) => {
    const newer = extra.get(c.claimIndex)?.newer ?? [];
    const dates = newer.map((s) => evidenceDate(s)).join(", ");
    return [
      {
        rule: `claim-${c.claimIndex + 1}:support`,
        status: c.supported ? "passed" : "failed",
        reason: c.reason,
      },
      {
        rule: `claim-${c.claimIndex + 1}:currentness`,
        status: c.supersededByNewer
          ? "failed"
          : newer.length
            ? "passed"
            : "not_applicable",
        reason: c.supersededByNewer
          ? `Newer evidence (${dates}) describes a different current state; cite it or date the claim as historical`
          : newer.length
            ? `${newer.length} newer passage(s) (${dates}) were compared and do not contradict this claim`
            : "No newer passage of equal or higher authority was retrieved for this subject",
      },
    ] satisfies CheckResult[];
  });
  if (result.questionMode === "synthesis") {
    const cited = claims.flatMap((c) =>
      c.citations.map((id) => registry.get(id)!),
    );
    const groups = new Set(cited.map((s) => s.duplicateGroup));
    const dates = new Set(
      cited.map((s) =>
        (s.publishedAt ?? s.updatedAt ?? s.fetchedAt).slice(0, 10),
      ),
    );
    checks.push({
      rule: "synthesis-evidence",
      status: groups.size >= 2 && dates.size >= 2 ? "passed" : "failed",
      reason:
        "Historical synthesis requires multiple independent sources and distinct dated observations.",
    });
  }
  return checks;
}
