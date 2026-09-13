import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceConfig } from '../../contracts.js';
import { openDatabase } from '../../storage/database.js';
import type { FetchTransport } from './fetch.js';
import { crawlSource } from './crawl-source.js';

const source: SourceConfig = { id: 'site', url: 'https://public.example/start', publisher: 'Example', authority: 1, kind: 'website', reason: 'Primary source', enabled: true };
const paragraph = 'This is a meaningful public document about staking infrastructure, operational conditions, evidence, and network support.';
function response(url: URL, status: number, body: string, headers: Record<string, string> = {}) {
  return { url: url.href, status, headers, body: Buffer.from(body) };
}

test('discovers seeds, sitemaps, and bounded links while reporting outside hosts', async () => {
  const transport: FetchTransport = async url => {
    if (url.pathname === '/robots.txt') return response(url, 200, 'User-agent: *\nAllow: /\nSitemap: https://public.example/sitemap.xml');
    if (url.pathname === '/sitemap.xml') return response(url, 200, '<urlset><url><loc>https://public.example/from-map</loc></url></urlset>', { 'content-type': 'application/xml' });
    if (url.pathname === '/start') return response(url, 200, `<main><h1>Start</h1><p>${paragraph}</p><a href="/linked">More</a><a href="https://outside.example/item">Outside</a></main>`, { 'content-type': 'text/html' });
    return response(url, 200, `<main><h1>Page</h1><p>${paragraph} ${url.pathname}</p></main>`, { 'content-type': 'text/html' });
  };
  const db = openDatabase(':memory:');
  const report = await crawlSource(db, source, { maxPages: 5, maxDepth: 1, concurrency: 2, fetchOptions: { transport, resolveHost: async () => ['93.184.216.34'], retries: 0, minDelayMs: 0 } });
  assert.equal(report.documents.length, 3);
  assert.deepEqual(report.documents.map(item => new URL(item.url).pathname).sort(), ['/from-map', '/linked', '/start']);
  assert.deepEqual(report.candidates, [{ url: 'https://outside.example/item', discoveredFrom: 'https://public.example/start' }]);
  assert.equal((report.documents[0]!.metadata.removedInstructions as unknown[]).length, 0);
  assert.equal((db.prepare('SELECT count(*) AS count FROM crawl_events WHERE status=?').get('accepted') as { count: number }).count, 3);
  db.close();
});
