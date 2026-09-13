import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelClient, ModelRequest } from "../../contracts.js";
import {
  conservativeReview,
  reviewSpeakers,
  validateReview,
} from "./review-speakers.js";
import type { Turn } from "./turns.js";

const turns: Turn[] = [
  {
    speaker: "1",
    startMs: 0,
    endMs: 1_000,
    text: "I am Alice from Everstake.",
  },
  {
    speaker: "2",
    startMs: 1_100,
    endMs: 2_000,
    text: "Welcome to the interview.",
  },
];

test("speaker identity evidence from another label is downgraded without a retry", async () => {
  let calls = 0;
  const model: ModelClient = {
    async generate() {
      calls += 1;
      return {
        model: "fixture",
        inputTokens: 1,
        outputTokens: 1,
        text: JSON.stringify({
          status: "reviewed",
          suspiciousIntervals: [],
          limitations: [],
          speakers: [
            {
              label: "1",
              name: "Alice",
              roleAtRecording: "Everstake employee",
              participantType: "employee",
              evidenceTurnIndexes: [1],
              reason: "self-introduction",
            },
            {
              label: "2",
              name: null,
              roleAtRecording: null,
              participantType: "interviewer",
              evidenceTurnIndexes: [1],
              reason: "welcomes guest",
            },
          ],
        }),
      };
    },
  };
  const result = await reviewSpeakers(model, "run-1", turns, {});
  assert.equal(result.status, "needs_review");
  assert.equal(result.speakers[0]?.name, null);
  assert.deepEqual(result.speakers[0]?.evidenceTurnIndexes, []);
  assert.equal(calls, 1);
});

test("speaker review uses one model pass and retains unknown identity", async () => {
  let calls = 0;
  let request: ModelRequest | undefined;
  const model: ModelClient = {
    async generate(value) {
      calls += 1;
      request = value;
      return {
        model: "fixture",
        inputTokens: 1,
        outputTokens: 1,
        text: JSON.stringify({
          status: "reviewed",
          suspiciousIntervals: [],
          limitations: ["Speaker 2 name is not stated."],
          speakers: [
            {
              label: "1",
              name: "Alice",
              roleAtRecording: "Everstake employee",
              participantType: "employee",
              evidenceTurnIndexes: [0],
              reason: "self-introduction",
            },
            {
              label: "2",
              name: null,
              roleAtRecording: null,
              participantType: "unknown",
              evidenceTurnIndexes: [],
              reason: "identity not stated",
            },
          ],
        }),
      };
    },
  };
  const result = await reviewSpeakers(model, "run-2", turns, {});
  assert.equal(result.speakers[1]?.name, null);
  assert.deepEqual(result.excludedTurnIndexes, []);
  assert.equal(calls, 1);
  assert.equal(request?.model, "gemini-3.8-flash");
});

test("a host introduction can ground the identity of the guest who responds", () => {
  const introducedTurns: Turn[] = [
    {
      speaker: "host",
      startMs: 0,
      endMs: 1_000,
      text: "Our guest is Bohdan Opryshko, COO at Everstake.",
    },
    {
      speaker: "guest",
      startMs: 1_100,
      endMs: 2_000,
      text: "Thank you for inviting me.",
    },
  ];
  const result = conservativeReview(
    {
      status: "reviewed",
      suspiciousIntervals: [],
      excludedTurnIndexes: [],
      limitations: [],
      speakers: [
        {
          label: "host",
          name: null,
          roleAtRecording: null,
          participantType: "unknown",
          evidenceTurnIndexes: [],
          reason: "Name is not stated.",
        },
        {
          label: "guest",
          name: "Bohdan Opryshko",
          roleAtRecording: "COO at Everstake",
          participantType: "employee",
          evidenceTurnIndexes: [],
          introductionEvidence: [
            {
              introductionTurnIndex: 0,
              responseTurnIndex: 1,
              reason: "The host introduces the guest, who responds next.",
            },
          ],
          reason: "Explicit host introduction linked to the guest response.",
        },
      ],
    },
    introducedTurns,
  );
  assert.equal(result.status, "reviewed");
  assert.equal(result.speakers[1]?.name, "Bohdan Opryshko");
  assert.deepEqual(result.speakers[1]?.introductionEvidence, [
    {
      introductionTurnIndex: 0,
      responseTurnIndex: 1,
      reason: "The host introduces the guest, who responds next.",
    },
  ]);
  validateReview(result, introducedTurns);
});

test("an introduction linked to a later non-first response cannot identify a label", () => {
  const introducedTurns: Turn[] = [
    { speaker: "host", startMs: 0, endMs: 1, text: "Meet Alice." },
    { speaker: "guest", startMs: 2, endMs: 3, text: "Hello." },
    { speaker: "host", startMs: 4, endMs: 5, text: "A question." },
    { speaker: "guest", startMs: 6, endMs: 7, text: "An answer." },
  ];
  const result = conservativeReview(
    {
      status: "reviewed",
      suspiciousIntervals: [],
      limitations: [],
      speakers: [
        {
          label: "guest",
          name: "Alice",
          roleAtRecording: "Everstake employee",
          participantType: "employee",
          evidenceTurnIndexes: [],
          introductionEvidence: [
            {
              introductionTurnIndex: 0,
              responseTurnIndex: 3,
              reason: "Incorrectly skips the first guest response.",
            },
          ],
          reason: "Claimed introduction.",
        },
      ],
    },
    introducedTurns,
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.speakers[0]?.name, null);
  assert.deepEqual(result.speakers[0]?.introductionEvidence, []);
});

test("out-of-bounds excluded turns are rejected by validation", () => {
  assert.throws(
    () =>
      validateReview(
        {
          status: "needs_review",
          suspiciousIntervals: [],
          excludedTurnIndexes: [turns.length],
          limitations: [],
          speakers: [],
        },
        turns,
      ),
    /Excluded turn index is out of bounds/,
  );
});

test("model output quarantines invalid excluded-turn references", async () => {
  const model: ModelClient = {
    async generate() {
      return {
        model: "fixture",
        inputTokens: 1,
        outputTokens: 1,
        text: JSON.stringify({
          status: "reviewed",
          suspiciousIntervals: [],
          excludedTurnIndexes: [0, 99],
          limitations: [],
          speakers: [
            {
              label: "1",
              name: "Alice",
              roleAtRecording: "Everstake employee",
              participantType: "employee",
              evidenceTurnIndexes: [0],
              introductionEvidence: [],
              reason: "self-introduction",
            },
            {
              label: "2",
              name: null,
              roleAtRecording: null,
              participantType: "unknown",
              evidenceTurnIndexes: [],
              introductionEvidence: [],
              reason: "identity not stated",
            },
          ],
        }),
      };
    },
  };
  const result = await reviewSpeakers(model, "run-3", turns, {});
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.excludedTurnIndexes, [0]);
});

test("unsupported role without an identified person is downgraded without retry", () => {
  const result = conservativeReview(
    {
      status: "reviewed",
      suspiciousIntervals: [],
      limitations: [],
      speakers: [
        {
          label: "1",
          name: null,
          roleAtRecording: "Host",
          participantType: "interviewer",
          evidenceTurnIndexes: [0],
          reason: "sounds like host",
        },
      ],
    },
    turns,
  );
  assert.equal(result.status, "needs_review");
  assert.equal(result.speakers[0]?.roleAtRecording, null);
  assert.equal(result.speakers[0]?.participantType, "interviewer");
});
