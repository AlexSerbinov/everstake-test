import type { Turn } from "./turns.js";
import type { SpeakerReview } from "./review-speakers.js";

/** Unattributed dialogue stays readable, but cannot become company testimony. */
export function isEvidenceEligible(
  turn: Turn,
  index: number,
  review: SpeakerReview,
): boolean {
  if (
    review.status !== "reviewed" ||
    !Array.isArray(review.excludedTurnIndexes)
  )
    return false;
  if (
    (
      review as SpeakerReview & { excludedTurnIndexes?: number[] }
    ).excludedTurnIndexes?.includes(index)
  )
    return false;
  if (
    review.suspiciousIntervals.some(
      (range) => index >= range.fromTurn && index <= range.toTurn,
    )
  )
    return false;
  const speaker = review.speakers.find((item) => item.label === turn.speaker);
  return Boolean(
    speaker?.name &&
    speaker.roleAtRecording &&
    speaker.participantType === "employee",
  );
}
