import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDocument } from "./pipeline.js";
import type { SpeakerReview } from "./review-speakers.js";
import type { VideoCandidate } from "./screen-videos.js";

const candidate: VideoCandidate = {
  id: "DFSEQ3OGoL8",
  title: "Interview",
  channelId: "third-party",
  channel: "Host",
  url: "https://www.youtube.com/watch?v=DFSEQ3OGoL8",
  publishedAt: "2024-01-01",
  durationSeconds: 60,
  decision: "accepted",
  reason: "explicit interview participation",
  metadata: { recordingDate: null },
};
const turns = [
  {
    speaker: "2",
    startMs: 0,
    endMs: 1_000,
    text: "I lead engineering at Everstake.",
  },
];

test("verified company testimony in a third-party interview is tier two with a scope warning", () => {
  const review: SpeakerReview = {
    status: "reviewed",
    suspiciousIntervals: [],
    limitations: [],
    speakers: [
      {
        label: "2",
        name: "A Person",
        roleAtRecording: "Engineering lead at Everstake",
        participantType: "employee",
        evidenceTurnIndexes: [0],
        reason: "self-identification",
      },
    ],
  };
  const document = buildDocument(
    candidate,
    turns,
    review,
    "2026-01-01T00:00:00Z",
  );
  assert.equal(document.authority, 2);
  assert.equal(document.metadata.speakerName, "A Person");
  assert.match(
    String(document.metadata.freshnessNote),
    /interviewer questions are context/i,
  );
});

test("brand metadata without a verified company speaker remains tier three", () => {
  const review: SpeakerReview = {
    status: "reviewed",
    suspiciousIntervals: [],
    limitations: [],
    speakers: [
      {
        label: "2",
        name: null,
        roleAtRecording: null,
        participantType: "unknown",
        evidenceTurnIndexes: [],
        reason: "unknown",
      },
    ],
  };
  assert.equal(buildDocument(candidate, turns, review).authority, 3);
});
