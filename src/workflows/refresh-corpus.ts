import type { SourceConfig } from '../contracts.js';
import type { Database } from '../storage/database.js';
import { crawlSource, type CrawlReport } from '../services/crawler/crawl-source.js';
import { buildIndex, type BuildIndexReport } from '../services/indexer/build-index.js';
import { crawlOptionsFor, readActiveDocuments, type BuildCorpusOptions } from './build-corpus.js';

export interface RefreshCorpusOptions extends BuildCorpusOptions {
  sourceIds?: string[];
}

export interface CorpusRefreshReport {
  crawls: CrawlReport[];
  failures: Array<{ sourceId: string; reason: string }>;
  retainedSourceIds: string[];
  index: BuildIndexReport | null;
}

/** Refreshes selected sources and retains their active snapshots when collection fails. */
export async function refreshCorpus(db: Database, sources: SourceConfig[], options: RefreshCorpusOptions = {}): Promise<CorpusRefreshReport> {
  const selected = sources.filter(source => source.enabled && (!options.sourceIds || options.sourceIds.includes(source.id)));
  const crawls: CrawlReport[] = [];
  const failures: CorpusRefreshReport['failures'] = [];
  const successfulIds = new Set<string>();
  for (const source of selected) {
    try {
      const report = await crawlSource(db, source, crawlOptionsFor(source, options));
      crawls.push(report);
      if (report.documents.length === 0) failures.push({ sourceId: source.id, reason: 'no_accepted_documents' });
      else successfulIds.add(source.id);
    } catch (error) {
      failures.push({ sourceId: source.id, reason: error instanceof Error ? error.message : String(error) });
      if (options.continueOnSourceError === false) throw error;
    }
  }
  const gone = new Set(crawls.flatMap(r => r.exclusions.filter(e => e.reason === 'http_error' && /HTTP (404|410)\b/.test(e.detail ?? '')).map(e => e.url)));
  if (successfulIds.size === 0 && gone.size === 0) return { crawls, failures, retainedSourceIds: selected.map(source => source.id), index: null };
  const refreshed = crawls.filter(report => successfulIds.has(report.sourceId)).flatMap(report => report.documents);
  const refreshedKeys = new Set(refreshed.flatMap(document => [document.url, document.canonicalUrl]));
  const selectedIds = new Set(selected.map(s => s.id));
  const retained = readActiveDocuments(db).filter(document => !gone.has(document.url) && !gone.has(document.canonicalUrl) && (!successfulIds.has(String(document.metadata.sourceId ?? '')) || (!refreshedKeys.has(document.url) && !refreshedKeys.has(document.canonicalUrl)))).map(document => selectedIds.has(String(document.metadata.sourceId ?? '')) ? {...document, metadata: {...document.metadata, refreshStatus: 'not_rechecked', freshnessNote: 'Retained historical snapshot; not verified by this refresh'}} : document);
  if (!retained.length && !refreshed.length) {
    db.exec('BEGIN IMMEDIATE');
    try { db.prepare('UPDATE documents SET active=0 WHERE url IN ('+[...gone].map(()=>'?').join(',')+')').run(...gone); db.prepare("UPDATE settings SET value=? WHERE key='corpus_version'").run('empty-'+Date.now()); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; }
    return {crawls,failures,retainedSourceIds:[],index:null};
  }
  const index = buildIndex(db, [...retained, ...refreshed], { version: options.version });
  return { crawls, failures, retainedSourceIds: failures.map(failure => failure.sourceId), index };
}
