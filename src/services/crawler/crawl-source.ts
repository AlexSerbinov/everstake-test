import { createHash } from 'node:crypto';
import type { SourceConfig, DocumentSnapshot } from '../../contracts.js';
import type { Database } from '../../storage/database.js';
import { sanitizeDocument } from '../evidence/sanitize-document.js';
import { discoverSitemaps } from './discover.js';
import { extractDocument, normalizeUrl } from './extract.js';
import { CrawlFetchError, safeFetch, type SafeFetchOptions } from './fetch.js';

export type CrawlStatus = 'accepted' | 'excluded' | 'candidate' | 'pending';
export interface CrawlProgress { sourceId: string; url: string; status: CrawlStatus; reason: string; accepted: number; queued: number; }
export interface CrawlExclusion { url: string; reason: string; detail?: string; }
export interface CrawlSourceOptions {
  explicitUrls?: string[];
  allowedHosts?: string[];
  includePaths?: string[];
  excludePaths?: string[];
  discoverSitemaps?: boolean;
  discoverLinks?: boolean;
  maxDepth?: number;
  maxPages?: number;
  concurrency?: number;
  maxTotalBytes?: number;
  maxDiscoveredUrls?: number;
  fetchOptions?: SafeFetchOptions;
  onProgress?: (event: CrawlProgress) => void;
}
export interface CrawlReport {
  sourceId: string;
  documents: DocumentSnapshot[];
  exclusions: CrawlExclusion[];
  candidates: Array<{ url: string; discoveredFrom: string }>;
  pending: string[];
  stats: { seeds: number; discovered: number; fetched: number; accepted: number; excluded: number; bytes: number; };
}

interface QueueItem { url: string; depth: number; discoveredFrom: string; }
type ExtendedSourceConfig = SourceConfig & { seedUrls?: string[]; allowedHosts?: string[]; includePaths?: string[]; excludePaths?: string[]; expand?: boolean };

function errorReason(error: unknown): { reason: string; detail: string } {
  if (error instanceof CrawlFetchError) return { reason: error.code, detail: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/^([a-z_]+):/)?.[1];
  return { reason: code ?? 'fetch_or_extract_failure', detail: message };
}

function finaliseSanitation(document: ReturnType<typeof extractDocument>): DocumentSnapshot {
  const sanitized = sanitizeDocument(document.text);
  const contentHash = createHash('sha256').update(sanitized.text).digest('hex');
  const id = createHash('sha256').update(`${document.canonicalUrl}\n${contentHash}`).digest('hex').slice(0, 32);
  const { links: _links, ...snapshot } = document;
  return {
    ...snapshot,
    id,
    text: sanitized.text,
    contentHash,
    revision: contentHash.slice(0, 12),
    metadata: { ...document.metadata, removedInstructionCount: sanitized.removed.length, removedInstructionRules: [...new Set(sanitized.removed.map(r => r.rule))] },
  };
}

function record(db: Database, url: string, status: CrawlStatus, reason: string): void {
  db.prepare('INSERT INTO crawl_events(url,status,reason,checked_at) VALUES(?,?,?,?)').run(url, status, reason, new Date().toISOString());
}

/** Crawls one configured source with bounded discovery and explicit outcomes. */
export async function crawlSource(db: Database, source: SourceConfig, options: CrawlSourceOptions = {}): Promise<CrawlReport> {
  if (source.kind === 'youtube') throw new Error('YouTube is handled by the dedicated video ingestion service');
  const configured = source as ExtendedSourceConfig;
  const configuredSeeds = configured.seedUrls?.length ? configured.seedUrls : [source.url];
  const seeds = [...new Set((options.explicitUrls?.length ? options.explicitUrls : configuredSeeds).map(normalizeUrl))];
  const allowedHosts = new Set((options.allowedHosts?.length ? options.allowedHosts : configured.allowedHosts?.length ? configured.allowedHosts : [new URL(source.url).hostname]).map(host => host.toLowerCase()));
  const includePaths = options.includePaths ?? configured.includePaths ?? ['/'];
  const excludePaths = options.excludePaths ?? configured.excludePaths ?? [];
  const maxDepth = options.maxDepth ?? 2;
  const maxPages = options.maxPages ?? 1_000;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const maxTotalBytes = options.maxTotalBytes ?? 500_000_000;
  const queue: QueueItem[] = [];
  const queued = new Set<string>();
  const visited = new Set<string>();
  const documents: DocumentSnapshot[] = [];
  const exclusions: CrawlExclusion[] = [];
  const candidates: CrawlReport['candidates'] = [];
  let fetched = 0;
  let bytes = 0;
  const robotsCache = options.fetchOptions?.robotsCache ?? new Map();
  const fetchOptions = {
    minDelayMs: options.fetchOptions?.minDelayMs ?? 250,
    ...options.fetchOptions,
    robotsCache,
    rateLimitState: options.fetchOptions?.rateLimitState ?? { tails: new Map<string, Promise<void>>(), lastStartedAt: new Map<string, number>() },
  };
  const emit = (url: string, status: CrawlStatus, reason: string): void => {
    record(db, url, status, reason);
    options.onProgress?.({ sourceId: source.id, url, status, reason, accepted: documents.length, queued: queue.length });
  };
  const permitted = (value: string): boolean => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && allowedHosts.has(url.hostname.toLowerCase()) && includePaths.some(prefix => url.pathname.startsWith(prefix)) && !excludePaths.some(prefix => url.pathname.startsWith(prefix));
  };
  for (const url of seeds) {
    if (permitted(url)) {
      queued.add(url);
      queue.push({ url, depth: 0, discoveredFrom: 'seed' });
    } else {
      candidates.push({ url, discoveredFrom: 'seed' });
    }
  }
  const enqueue = (value: string, depth: number, discoveredFrom: string): void => {
    let normalized: string;
    try { normalized = normalizeUrl(value); } catch { return; }
    if (!permitted(normalized)) {
      if (!allowedHosts.has(new URL(normalized).hostname.toLowerCase())) candidates.push({ url: normalized, discoveredFrom });
      else exclusions.push({ url: normalized, reason: 'path_excluded' });
      return;
    }
    if (!queued.has(normalized) && !visited.has(normalized)) {
      queued.add(normalized);
      queue.push({ url: normalized, depth, discoveredFrom });
    }
  };

  const expand = configured.expand !== false;
  if (options.discoverSitemaps ?? expand) {
    const discovery = await discoverSitemaps(source.url, { ...fetchOptions, maxUrls: options.maxDiscoveredUrls ?? Math.max(maxPages * 20, 1_000) });
    for (const url of discovery.urls) enqueue(url, 0, 'sitemap');
    for (const failure of discovery.errors) exclusions.push({ url: failure.url, reason: 'sitemap_failure', detail: failure.reason });
  }

  while (queue.length && documents.length < maxPages && bytes < maxTotalBytes) {
    const room = Math.min(concurrency, maxPages - documents.length);
    const batch = queue.splice(0, room).filter(item => !visited.has(item.url));
    batch.forEach(item => visited.add(item.url));
    const results = await Promise.all(batch.map(async item => {
      try {
        const response = await safeFetch(item.url, fetchOptions);
        fetched += 1;
        bytes += response.bytes;
        if (bytes > maxTotalBytes) return { item, exclusion: { url: item.url, reason: 'total_bytes_limit' } as CrawlExclusion };
        const extracted = extractDocument(response, source);
        if (extracted.text.length < 80) return { item, exclusion: { url: item.url, reason: 'insufficient_content' } as CrawlExclusion };
        return { item, extracted, document: finaliseSanitation(extracted) };
      } catch (error) {
        const failure = errorReason(error);
        return { item, exclusion: { url: item.url, reason: failure.reason, detail: failure.detail } as CrawlExclusion };
      }
    }));
    for (const result of results) {
      if (result.exclusion) {
        exclusions.push(result.exclusion);
        emit(result.item.url, 'excluded', result.exclusion.reason);
        continue;
      }
      documents.push(result.document!);
      emit(result.item.url, 'accepted', 'document_extracted');
      if ((options.discoverLinks ?? expand) && result.item.depth < maxDepth) {
        for (const link of result.extracted!.links) enqueue(link, result.item.depth + 1, result.item.url);
      }
    }
  }
  const pending = queue.map(item => item.url);
  for (const url of pending) emit(url, 'pending', documents.length >= maxPages ? 'page_limit' : 'byte_limit');
  for (const candidate of candidates) emit(candidate.url, 'candidate', 'host_not_allowed');
  return {
    sourceId: source.id,
    documents,
    exclusions,
    candidates,
    pending,
    stats: { seeds: seeds.length, discovered: queued.size, fetched, accepted: documents.length, excluded: exclusions.length, bytes },
  };
}
