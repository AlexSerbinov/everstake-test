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
  answerScope: z.object({ supported: z.boolean(), reason: z.string() }),
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
            newerEvidence: extra.get(claimIndex)?.newer ?? [],
            exceptionEvidence: extra.get(claimIndex)?.exceptions ?? [],
            relatedEvidence: extra.get(claimIndex)?.related ?? [],
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
  // The small reviewer sees every claim and passage at once and can miss a changed role or
  // count buried in a long page. A claim that has newer evidence gets one focused comparison
  // by the stronger answer model; either reviewer can mark it superseded.
  const focused = new Map<number, { superseded: boolean; reason: string }>();
  const scoped = new Map<number, { unqualified: boolean; reason: string }>();
  for (const check of result.checks) {
    const claim = claims[check.claimIndex]!;
    const newer = extra.get(check.claimIndex)?.newer ?? [];
    if (newer.length && !check.supersededByNewer)
      focused.set(
        check.claimIndex,
        await reviewCurrentness(model, runId, signal, question, claim, newer),
      );
    const exceptions = extra.get(check.claimIndex)?.exceptions ?? [];
    if (exceptions.length && check.supported)
      scoped.set(
        check.claimIndex,
        await reviewScope(model, runId, signal, question, claim, exceptions),
      );
  }
  const checks: CheckResult[] = result.checks.flatMap((c) => {
    const newer = extra.get(c.claimIndex)?.newer ?? [];
    const dates = newer.map((s) => evidenceDate(s)).join(", ");
    const strong = focused.get(c.claimIndex);
    const scope = scoped.get(c.claimIndex);
    const superseded = c.supersededByNewer || strong?.superseded === true;
    const unqualified = scope?.unqualified === true;
    const exceptions = extra.get(c.claimIndex)?.exceptions ?? [];
    return [
      {
        rule: `claim-${c.claimIndex + 1}:support`,
        status:
          c.supported && !superseded && !unqualified ? "passed" : "failed",
        reason:
          c.supported && superseded
            ? (strong?.reason ?? c.reason)
            : c.supported && unqualified
              ? `Absolute wording is limited by an exception in the corpus; qualify it. ${scope!.reason}`
              : c.reason,
      },
      ...(exceptions.length
        ? [
            {
              rule: `claim-${c.claimIndex + 1}:scope`,
              status: unqualified ? "failed" : "passed",
              reason: unqualified
                ? `An exception or optional path was found for this absolute statement. ${scope!.reason}`
                : `${exceptions.length} passage(s) retrieved for exceptions do not limit this statement`,
            } satisfies CheckResult,
          ]
        : []),
      {
        rule: `claim-${c.claimIndex + 1}:currentness`,
        status: superseded
          ? "failed"
          : newer.length
            ? "passed"
            : "not_applicable",
        reason: superseded
          ? `Newer evidence (${dates}) describes a different current state; cite it or date the claim as historical. ${strong?.reason ?? c.reason}`
          : newer.length
            ? `${newer.length} newer passage(s) (${dates}) were compared and do not contradict this claim`
            : "No newer passage of equal or higher authority was retrieved for this subject",
      },
    ] satisfies CheckResult[];
  });
  // A broad lightweight review can approve each quantity while missing the relationship
  // implied by their juxtaposition. Compare multi-value answers as a whole, with only
  // their cited passages, using the answer model (the same pattern as currentness review).
  const scopeReview =
    result.answerScope.supported && !checks.some((c) => c.status === "failed")
      ? await reviewAnswerScope(
          model,
          runId,
          signal,
          question,
          claims,
          registry,
          counterevidence,
        )
      : result.answerScope;
  checks.push({
    rule: "answer-scope",
    status: scopeReview.supported ? "passed" : "failed",
    reason: scopeReview.reason,
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

async function reviewedJson<T extends z.ZodType>(
  model: ModelClient,
  request: Parameters<ModelClient["generate"]>[0],
  schema: T,
): Promise<z.infer<T>> {
  const formatted = {
    ...request,
    system:
      request.system +
      "\n\n" +
      readFileSync("prompts/review-format.md", "utf8") +
      "\n" +
      JSON.stringify(z.toJSONSchema(schema)),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await model.generate(
      attempt === 0
        ? formatted
        : {
            ...formatted,
            messages: [
              ...request.messages,
              {
                role: "user",
                text: readFileSync("prompts/review-retry.md", "utf8"),
              },
            ],
          },
    );
    try {
      return schema.parse(
        JSON.parse(
          response.text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
        ),
      );
    } catch {
      if (attempt === 1)
        throw new Error(
          `${request.stage} returned an unreadable review after two metered attempts`,
        );
    }
  }
  throw new Error("Unreachable review state");
}

async function reviewAnswerScope(
  model: ModelClient,
  runId: string,
  signal: AbortSignal | undefined,
  question: string,
  claims: Claim[],
  registry: Map<string, EvidencePassage>,
  counterevidence: ClaimCounterevidence[],
): Promise<{ supported: boolean; reason: string }> {
  const ids = new Set(claims.flatMap((claim) => claim.citations));
  const assessed = await reviewedJson(
    model,
    {
      runId,
      signal,
      stage: "answer-scope-review",
      system: readFileSync("prompts/answer-scope.md", "utf8"),
      thinkingLevel: "medium",
      messages: [
        {
          role: "user",
          text: JSON.stringify({
            question,
            claims,
            untrustedEvidence: [...ids].map((id) => registry.get(id)),
            otherRetrievedEvidence: [
              ...new Map(
                [
                  ...registry.values(),
                  ...counterevidence.flatMap((c) => [
                    ...c.newer,
                    ...c.exceptions,
                    ...(c.related ?? []),
                  ]),
                ]
                  .filter((s) => !ids.has(s.id))
                  .map((s) => [s.id, s]),
              ).values(),
            ],
          }),
        },
      ],
      maxOutputTokens: 4000,
    },
    z.object({
      unsupportedAssumptions: z.array(z.string()),
      supported: z.boolean(),
      reason: z.string().trim().min(1),
    }),
  );
  return {
    supported:
      assessed.supported && assessed.unsupportedAssumptions.length === 0,
    reason: [assessed.reason, ...assessed.unsupportedAssumptions].join(" "),
  };
}

const currentnessSchema = z.object({
  superseded: z.boolean(),
  reason: z.string(),
});
async function reviewCurrentness(
  model: ModelClient,
  runId: string,
  signal: AbortSignal | undefined,
  question: string,
  claim: Claim,
  newer: EvidencePassage[],
): Promise<{ superseded: boolean; reason: string }> {
  return reviewedJson(
    model,
    {
      runId,
      signal,
      stage: "currentness-review",
      system: readFileSync("prompts/currentness.md", "utf8"),
      messages: [
        {
          role: "user",
          text: JSON.stringify({
            question,
            claim,
            newerPassages: newer.map((s) => ({
              id: s.id,
              url: s.url,
              date: evidenceDate(s),
              authority: s.authority,
              text: s.text,
            })),
          }),
        },
      ],
      thinkingLevel: "low",
      maxOutputTokens: 3000,
    },
    currentnessSchema,
  );
}

const scopeSchema = z.object({ unqualified: z.boolean(), reason: z.string() });
async function reviewScope(
  model: ModelClient,
  runId: string,
  signal: AbortSignal | undefined,
  question: string,
  claim: Claim,
  exceptions: EvidencePassage[],
): Promise<{ unqualified: boolean; reason: string }> {
  return reviewedJson(
    model,
    {
      runId,
      signal,
      stage: "scope-review",
      system: readFileSync("prompts/scope.md", "utf8"),
      messages: [
        {
          role: "user",
          text: JSON.stringify({
            question,
            claim,
            exceptionPassages: exceptions.map((s) => ({
              id: s.id,
              url: s.url,
              date: evidenceDate(s),
              authority: s.authority,
              text: s.text,
            })),
          }),
        },
      ],
      thinkingLevel: "low",
      maxOutputTokens: 3000,
    },
    scopeSchema,
  );
}
