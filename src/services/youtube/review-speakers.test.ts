import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelClient } from '../../contracts.js';
import { conservativeReview, reviewSpeakers } from './review-speakers.js';
import type { Turn } from './turns.js';

const turns: Turn[] = [
  { speaker: '1', startMs: 0, endMs: 1_000, text: 'I am Alice from Everstake.' },
  { speaker: '2', startMs: 1_100, endMs: 2_000, text: 'Welcome to the interview.' },
];

test('speaker identity evidence from another label is downgraded without a retry', async () => {
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
  const result = await reviewSpeakers(model, 'run-1', turns, {});
  assert.equal(result.status, 'needs_review');
  assert.equal(result.speakers[0]?.name, null);
  assert.deepEqual(result.speakers[0]?.evidenceTurnIndexes, []);
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

test('unsupported role without an identified person is downgraded without retry', () => {
  const result = conservativeReview({
    status: 'reviewed', suspiciousIntervals: [], limitations: [],
    speakers: [{ label: '1', name: null, roleAtRecording: 'Host', participantType: 'interviewer', evidenceTurnIndexes: [0], reason: 'sounds like host' }],
  }, turns);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.speakers[0]?.roleAtRecording, null);
  assert.equal(result.speakers[0]?.participantType, 'interviewer');
});
