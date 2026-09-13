import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentSnapshot, SourceConfig } from '../contracts.js';
import { getSetting, openDatabase } from '../storage/database.js';
import { buildIndex } from '../services/indexer/build-index.js';
import type { FetchTransport } from '../services/crawler/fetch.js';
import { refreshCorpus } from './refresh-corpus.js';

const source: SourceConfig = { id: 'site', url: 'https://public.example/fact', publisher: 'Example', authority: 1, kind: 'website', reason: 'Primary', enabled: true };
function response(url: URL, status: number, body: string, headers: Record<string, string> = {}) {
  return { url: url.href, status, headers, body: Buffer.from(body) };
}
function prior(): DocumentSnapshot {
  return { id: 'old', url: source.url, canonicalUrl: source.url, title: 'Old', publisher: 'Example', authority: 1, kind: 'website', text: 'The old but still usable fact remains available as evidence until a safe replacement succeeds.', contentHash: 'old', fetchedAt: '2026-09-12T00:00:00.000Z', publishedAt: null, updatedAt: null, dateEvidence: null, duplicateOf: null, revision: 'old', metadata: { sourceId: source.id } };
}

test('failed targeted refresh leaves the prior active corpus unchanged', async () => {
  const db = openDatabase(':memory:');
  buildIndex(db, [prior()], { version: 'v1' });
  const transport: FetchTransport = async url => response(url, 200, 'User-agent: *\nDisallow: /');
  const report = await refreshCorpus(db, [source], { version: 'v2', crawl: { discoverSitemaps: false, fetchOptions: { transport, resolveHost: async () => ['93.184.216.34'], retries: 0, minDelayMs: 0 } } });
  assert.equal(report.index, null);
  assert.equal(getSetting(db, 'corpus_version'), 'v1');
  assert.deepEqual([...db.prepare('SELECT id FROM documents WHERE active=1').all()].map(row => ({ ...row })), [{ id: 'old' }]);
  db.close();
});

test('successful targeted refresh stores the old revision but activates the replacement', async () => {
  const db = openDatabase(':memory:');
  buildIndex(db, [prior()], { version: 'v1' });
  const body = '<main><h1>Current fact</h1><p>The newly verified source now contains a materially changed fact with its full conditions and context for readers.</p></main>';
  const transport: FetchTransport = async url => url.pathname === '/robots.txt'
    ? response(url, 404, '')
    : response(url, 200, body, { 'content-type': 'text/html' });
  const report = await refreshCorpus(db, [source], { version: 'v2', crawl: { discoverSitemaps: false, fetchOptions: { transport, resolveHost: async () => ['93.184.216.34'], retries: 0, minDelayMs: 0 } } });
  assert.equal(report.index?.version, 'v2');
  const rows = [...db.prepare('SELECT id,active FROM documents ORDER BY active,id').all()].map(row => ({ ...row })) as Array<{ id: string; active: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.id, 'old');
  assert.equal(rows[0]?.active, 0);
  assert.equal(rows[1]?.active, 1);
  db.close();
});
