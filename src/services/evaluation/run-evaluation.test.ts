import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readQuestions, summarize } from './run-evaluation.js';
test('selected evaluation preserves twenty cases and five negatives',()=>{const q=readQuestions();assert.equal(q.length,20);assert.equal(q.filter(q=>q.negative).length,5);assert.equal(new Set(q.map(q=>q.id)).size,20);});
test('an ungraded run has unknown accuracy rather than a success rate',()=>{assert.equal(summarize([]).accuracy,null);});
