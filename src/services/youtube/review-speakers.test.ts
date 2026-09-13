import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelClient } from '../../contracts.js';
import { reviewSpeakers } from './review-speakers.js';
import type { Turn } from './turns.js';

const turns: Turn[] = [
  { speaker: '1', startMs: 0, endMs: 1_000, text: 'I am Alice from Everstake.' },
  { speaker: '2', startMs: 1_100, endMs: 2_000, text: 'Welcome to the interview.' },
];

test('speaker identity evidence must come from a turn with the same diarization label', async () => {
  let calls = 0;
  const model: ModelClient = {
    async generate() {
      calls += 1;
      return {
        model: 'fixture', inputTokens: 1, outputTokens: 1,
        text: JSON.stringify({
          status: 'reviewed', suspiciousIntervals: [], limitations: [],
          speakers: [
            { label: '1', name: 'Alice', roleAtRecording: 'Everstake employee', participantType: 'employee', evidenceTurnIndexes: [1], reason: 'self-introduction' },
            { label: '2', name: null, roleAtRecording: null, participantType: 'interviewer', evidenceTurnIndexes: [1], reason: 'welcomes guest' },
          ],
        }),
      };
    },
  };
  await assert.rejects(reviewSpeakers(model, 'run-1', turns, {}), /another label/);
  assert.equal(calls, 1);
});

test('speaker review uses one model pass and retains unknown identity', async () => {
  let calls = 0;
  const model: ModelClient = {
    async generate() {
      calls += 1;
      return {
        model: 'fixture', inputTokens: 1, outputTokens: 1,
        text: JSON.stringify({
          status: 'reviewed', suspiciousIntervals: [], limitations: ['Speaker 2 name is not stated.'],
          speakers: [
            { label: '1', name: 'Alice', roleAtRecording: 'Everstake employee', participantType: 'employee', evidenceTurnIndexes: [0], reason: 'self-introduction' },
            { label: '2', name: null, roleAtRecording: null, participantType: 'unknown', evidenceTurnIndexes: [], reason: 'identity not stated' },
          ],
        }),
      };
    },
  };
  const result = await reviewSpeakers(model, 'run-2', turns, {});
  assert.equal(result.speakers[1]?.name, null);
  assert.equal(calls, 1);
});
