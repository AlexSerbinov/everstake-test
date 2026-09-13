import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentSnapshot } from '../../contracts.js';
import { deduplicateDocuments } from './deduplicate.js';

function document(id: string, url: string, text: string, contentHash = id): DocumentSnapshot {
  return { id, url, canonicalUrl: url, title: id, publisher: 'Publisher', authority: 2, kind: 'news', text, contentHash, fetchedAt: '2026-09-13T00:00:00.000Z', publishedAt: null, updatedAt: null, dateEvidence: null, duplicateOf: null, revision: contentHash, metadata: {} };
}

test('groups exact and near copies but keeps every original snapshot', () => {
  const base = 'Everstake provides secure non-custodial staking for institutions and token holders across public proof of stake networks with transparent infrastructure operations.';
  const result = deduplicateDocuments([
    document('a', 'https://a.example/story', base, 'same'),
    document('b', 'https://b.example/story', base, 'same'),
    document('c', 'https://c.example/story', `${base} Read the full report.`, 'other'),
  ], 0.7);
  assert.equal(result.documents.length, 3);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]?.documentIds.length, 3);
  assert.equal(result.documents.filter(item => item.duplicateOf === null).length, 1);
});

test('keeps revised facts on the same canonical URL separate', () => {
  const result = deduplicateDocuments([
    document('old', 'https://example.com/fact', 'The service supports 70 networks.', 'old'),
    document('new', 'https://example.com/fact', 'The service supports 90 networks.', 'new'),
  ]);
  assert.equal(result.groups.length, 0);
  assert.ok(result.documents.every(item => item.duplicateOf === null));
});
