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
  // Older reviews did not classify evidence scope; the guard above rejects them.
  if (review.excludedTurnIndexes.includes(index)) return false;
  if (
    review.suspiciousIntervals.some(
      (range) => index >= range.fromTurn && index <= range.toTurn,
    )
  )
    return false;
  // A plausible speaker label is not enough: only named employees with a
  // recording-time role may contribute factual evidence.
  const speaker = review.speakers.find((item) => item.label === turn.speaker);
  return Boolean(
    speaker?.name &&
    speaker.roleAtRecording &&
    speaker.participantType === "employee",
  );
}
