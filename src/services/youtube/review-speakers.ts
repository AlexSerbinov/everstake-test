import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ModelClient } from "../../contracts.js";
import { formatTimestamp, type Turn } from "./turns.js";

const speakerSchema = z
  .object({
    label: z.string(),
    name: z.string().nullable(),
    roleAtRecording: z.string().nullable(),
    participantType: z.enum([
      "employee",
      "interviewer",
      "third_party",
      "unknown",
    ]),
    evidenceTurnIndexes: z.array(z.number().int().nonnegative()),
    introductionEvidence: z
      .array(
        z
          .object({
            introductionTurnIndex: z.number().int().nonnegative(),
            responseTurnIndex: z.number().int().nonnegative(),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    reason: z.string().min(1),
  })
  .strict();

const reviewSchema = z
  .object({
    status: z.enum(["reviewed", "needs_review"]),
    speakers: z.array(speakerSchema),
    suspiciousIntervals: z.array(
      z
        .object({
          fromTurn: z.number().int().nonnegative(),
          toTurn: z.number().int().nonnegative(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    excludedTurnIndexes: z.array(z.number().int().nonnegative()).default([]),
    limitations: z.array(z.string()),
  })
  .strict();

type ParsedSpeakerReview = z.infer<typeof reviewSchema>;
type ParsedSpeaker = ParsedSpeakerReview["speakers"][number];

/** Optional fields let previously saved reviews remain readable; model output is normalized to arrays. */
export type SpeakerReview = Omit<
  ParsedSpeakerReview,
  "speakers" | "excludedTurnIndexes"
> & {
  speakers: Array<
    Omit<ParsedSpeaker, "introductionEvidence"> & {
      introductionEvidence?: ParsedSpeaker["introductionEvidence"];
    }
  >;
  excludedTurnIndexes?: number[];
};

const MAX_INTRODUCTION_RESPONSE_GAP = 6;

/** One logical model pass covers identity, role-at-recording and label consistency together. */
export async function reviewSpeakers(
  model: ModelClient,
  runId: string,
  turns: Turn[],
  metadata: unknown,
): Promise<SpeakerReview> {
  if (!turns.length) throw new Error("Cannot review an empty transcript");
  const transcript = turns.map((turn, index) => ({
    index,
    label: turn.speaker,
    from: formatTimestamp(turn.startMs),
    to: formatTimestamp(turn.endMs),
    text: turn.text,
  }));
  const response = await model.generate({
    runId,
    stage: "youtube-speaker-review",
    system: readFileSync("assistant/prompts/speaker-review.md", "utf8"),
    messages: [
      {
        role: "user",
        text: JSON.stringify({
          publicMetadata: metadata,
          untrustedTimedTurns: transcript,
        }),
      },
    ],
    model: "gemini-3.8-flash",
    maxOutputTokens: 16_000,
  });
  const review = conservativeReview(
    reviewSchema.parse(parseJson(response.text)),
    turns,
  );
  validateReview(review, turns);
  return review;
}

/** Downgrade unsupported model attributions to review-required data instead of promoting them or retrying a paid call. */
export function conservativeReview(
  review: SpeakerReview,
  turns: Turn[],
): SpeakerReview {
  let downgraded = false;
  const speakers = review.speakers.map((speaker) => {
    const evidenceTurnIndexes = speaker.evidenceTurnIndexes.filter(
      (index) =>
        index < turns.length && turns[index]?.speaker === speaker.label,
    );
    const introductionEvidence = (speaker.introductionEvidence ?? []).filter(
      (evidence) => validIntroductionEvidence(speaker.label, evidence, turns),
    );
    const removedInvalidEvidence =
      evidenceTurnIndexes.length !== speaker.evidenceTurnIndexes.length ||
      introductionEvidence.length !==
        (speaker.introductionEvidence ?? []).length;
    const unsupportedAttribution =
      (speaker.name ||
        speaker.roleAtRecording ||
        speaker.participantType !== "unknown") &&
      evidenceTurnIndexes.length === 0 &&
      introductionEvidence.length === 0;
    const roleWithoutIdentity = Boolean(
      speaker.roleAtRecording && !speaker.name,
    );
    if (removedInvalidEvidence) downgraded = true;
    if (!unsupportedAttribution && !roleWithoutIdentity)
      return {
        ...speaker,
        evidenceTurnIndexes,
        introductionEvidence,
        reason: removedInvalidEvidence
          ? `${speaker.reason} Invalid evidence links were removed by deterministic validation.`
          : speaker.reason,
      };
    downgraded = true;
    return {
      ...speaker,
      name: unsupportedAttribution ? null : speaker.name,
      roleAtRecording: null,
      participantType: unsupportedAttribution
        ? ("unknown" as const)
        : speaker.participantType,
      evidenceTurnIndexes,
      introductionEvidence,
      reason: `${speaker.reason} Unsupported identity/role fields were removed by deterministic validation.`,
    };
  });
  const excludedTurnIndexes = [...new Set(review.excludedTurnIndexes ?? [])]
    .filter((index) => {
      const valid = index < turns.length;
      if (!valid) downgraded = true;
      return valid;
    })
    .sort((left, right) => left - right);
  return downgraded
    ? {
        ...review,
        status: "needs_review",
        speakers,
        excludedTurnIndexes,
        limitations: [
          ...review.limitations,
          "Invalid speaker evidence or excluded-turn references were removed; manual review is required.",
        ],
      }
    : { ...review, speakers, excludedTurnIndexes };
}

export function validateReview(review: SpeakerReview, turns: Turn[]): void {
  const labels = new Set(
    turns.flatMap((turn) => (turn.speaker === null ? [] : [turn.speaker])),
  );
  const seen = new Set<string>();
  for (const speaker of review.speakers) {
    if (!labels.has(speaker.label))
      throw new Error(
        `Speaker review references nonexistent label ${speaker.label}`,
      );
    if (seen.has(speaker.label))
      throw new Error(`Speaker review repeats label ${speaker.label}`);
    seen.add(speaker.label);
    for (const index of speaker.evidenceTurnIndexes) {
      if (index >= turns.length || turns[index].speaker !== speaker.label) {
        throw new Error(
          `Speaker ${speaker.label} cites a turn spoken by another label`,
        );
      }
    }
    for (const evidence of speaker.introductionEvidence ?? []) {
      if (!validIntroductionEvidence(speaker.label, evidence, turns)) {
        throw new Error(
          `Speaker ${speaker.label} has an invalid introduction-to-response link`,
        );
      }
    }
    if (
      (speaker.name ||
        speaker.roleAtRecording ||
        speaker.participantType !== "unknown") &&
      !speaker.evidenceTurnIndexes.length &&
      !(speaker.introductionEvidence ?? []).length
    ) {
      throw new Error(
        `Attributed speaker ${speaker.label} has no transcript evidence`,
      );
    }
    if (speaker.roleAtRecording && !speaker.name)
      throw new Error(`Role for ${speaker.label} has no identified person`);
  }
  for (const interval of review.suspiciousIntervals) {
    if (interval.fromTurn > interval.toTurn || interval.toTurn >= turns.length)
      throw new Error("Invalid review interval");
  }
  if (review.suspiciousIntervals.length && review.status !== "needs_review") {
    throw new Error(
      "Suspicious diarization intervals require needs_review status",
    );
  }
  for (const index of review.excludedTurnIndexes ?? []) {
    if (index >= turns.length)
      throw new Error(`Excluded turn index is out of bounds: ${index}`);
  }
  const missing = [...labels].filter((label) => !seen.has(label));
  if (missing.length && review.status !== "needs_review") {
    throw new Error(
      `Unreviewed speaker labels require needs_review status: ${missing.join(", ")}`,
    );
  }
}

function validIntroductionEvidence(
  label: string,
  evidence: {
    introductionTurnIndex: number;
    responseTurnIndex: number;
  },
  turns: Turn[],
): boolean {
  const introduction = turns[evidence.introductionTurnIndex];
  const response = turns[evidence.responseTurnIndex];
  if (
    !introduction ||
    !response ||
    introduction.speaker === null ||
    introduction.speaker === label ||
    response.speaker !== label ||
    evidence.responseTurnIndex <= evidence.introductionTurnIndex ||
    evidence.responseTurnIndex - evidence.introductionTurnIndex >
      MAX_INTRODUCTION_RESPONSE_GAP
  ) {
    return false;
  }
  return !turns
    .slice(evidence.introductionTurnIndex + 1, evidence.responseTurnIndex)
    .some((turn) => turn.speaker === label);
}

function parseJson(text: string): unknown {
  return JSON.parse(
    text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
  );
}
