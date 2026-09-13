import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ModelClient } from '../../contracts.js';
import { formatTimestamp, type Turn } from './turns.js';

const speakerSchema = z.object({
  label: z.string(),
  name: z.string().nullable(),
  roleAtRecording: z.string().nullable(),
  participantType: z.enum(['employee', 'interviewer', 'third_party', 'unknown']),
  evidenceTurnIndexes: z.array(z.number().int().nonnegative()),
  reason: z.string().min(1),
}).strict();

const reviewSchema = z.object({
  status: z.enum(['reviewed', 'needs_review']),
  speakers: z.array(speakerSchema),
  suspiciousIntervals: z.array(z.object({
    fromTurn: z.number().int().nonnegative(),
    toTurn: z.number().int().nonnegative(),
    reason: z.string().min(1),
  }).strict()),
  limitations: z.array(z.string()),
}).strict();

export type SpeakerReview = z.infer<typeof reviewSchema>;

/** One logical model pass covers identity, role-at-recording and label consistency together. */
export async function reviewSpeakers(
  model: ModelClient,
  runId: string,
  turns: Turn[],
  metadata: unknown,
): Promise<SpeakerReview> {
  if (!turns.length) throw new Error('Cannot review an empty transcript');
  const transcript = turns.map((turn, index) => ({
    index,
    label: turn.speaker,
    from: formatTimestamp(turn.startMs),
    to: formatTimestamp(turn.endMs),
    text: turn.text,
  }));
  const response = await model.generate({
    runId,
    stage: 'youtube-speaker-review',
    system: readFileSync('prompts/speaker-review.md', 'utf8'),
    messages: [{ role: 'user', text: JSON.stringify({ publicMetadata: metadata, untrustedTimedTurns: transcript }) }],
    maxOutputTokens: 5_000,
  });
  const review = conservativeReview(reviewSchema.parse(parseJson(response.text)), turns);
  validateReview(review, turns);
  return review;
}

/** Downgrade unsupported model attributions to review-required data instead of promoting them or retrying a paid call. */
export function conservativeReview(review: SpeakerReview, turns: Turn[]): SpeakerReview {
  let downgraded = false;
  const speakers = review.speakers.map(speaker => {
    const evidenceTurnIndexes = speaker.evidenceTurnIndexes.filter(index => index < turns.length && turns[index]?.speaker === speaker.label);
    const unsupportedAttribution = (speaker.name || speaker.roleAtRecording || speaker.participantType !== 'unknown') && evidenceTurnIndexes.length === 0;
    const roleWithoutIdentity = Boolean(speaker.roleAtRecording && !speaker.name);
    if (!unsupportedAttribution && !roleWithoutIdentity) return { ...speaker, evidenceTurnIndexes };
    downgraded = true;
    return {
      ...speaker,
      name: unsupportedAttribution ? null : speaker.name,
      roleAtRecording: null,
      participantType: unsupportedAttribution ? 'unknown' as const : speaker.participantType,
      evidenceTurnIndexes,
      reason: `${speaker.reason} Unsupported identity/role fields were removed by deterministic validation.`,
    };
  });
  return downgraded
    ? { ...review, status: 'needs_review', speakers, limitations: [...review.limitations, 'Unsupported speaker attribution was removed; manual review is required.'] }
    : { ...review, speakers };
}

export function validateReview(review: SpeakerReview, turns: Turn[]): void {
  const labels = new Set(turns.flatMap(turn => turn.speaker === null ? [] : [turn.speaker]));
  const seen = new Set<string>();
  for (const speaker of review.speakers) {
    if (!labels.has(speaker.label)) throw new Error(`Speaker review references nonexistent label ${speaker.label}`);
    if (seen.has(speaker.label)) throw new Error(`Speaker review repeats label ${speaker.label}`);
    seen.add(speaker.label);
    for (const index of speaker.evidenceTurnIndexes) {
      if (index >= turns.length || turns[index].speaker !== speaker.label) {
        throw new Error(`Speaker ${speaker.label} cites a turn spoken by another label`);
      }
    }
    if ((speaker.name || speaker.roleAtRecording || speaker.participantType !== 'unknown') && !speaker.evidenceTurnIndexes.length) {
      throw new Error(`Attributed speaker ${speaker.label} has no transcript evidence`);
    }
    if (speaker.roleAtRecording && !speaker.name) throw new Error(`Role for ${speaker.label} has no identified person`);
  }
  for (const interval of review.suspiciousIntervals) {
    if (interval.fromTurn > interval.toTurn || interval.toTurn >= turns.length) throw new Error('Invalid review interval');
  }
  if (review.suspiciousIntervals.length && review.status !== 'needs_review') {
    throw new Error('Suspicious diarization intervals require needs_review status');
  }
  const missing = [...labels].filter(label => !seen.has(label));
  if (missing.length && review.status !== 'needs_review') {
    throw new Error(`Unreviewed speaker labels require needs_review status: ${missing.join(', ')}`);
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
}
