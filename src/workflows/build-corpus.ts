import type { DocumentSnapshot, SourceConfig } from '../contracts.js';
import type { Database } from '../storage/database.js';
import { crawlSource, type CrawlProgress, type CrawlReport, type CrawlSourceOptions } from '../services/crawler/crawl-source.js';
import { buildIndex, type BuildIndexReport } from '../services/indexer/build-index.js';

export interface BuildCorpusOptions {
  crawl?: CrawlSourceOptions;
  sourceOptions?: Record<string, CrawlSourceOptions> | ((source: SourceConfig) => CrawlSourceOptions);
  version?: string;
  onProgress?: (event: CrawlProgress) => void;
  continueOnSourceError?: boolean;
}

export interface CorpusBuildReport {
  crawls: CrawlReport[];
  failures: Array<{ sourceId: string; reason: string }>;
  index: BuildIndexReport;
}

function optionsFor(source: SourceConfig, options: BuildCorpusOptions): CrawlSourceOptions {
  const sourceOptions = typeof options.sourceOptions === 'function' ? options.sourceOptions(source) : options.sourceOptions?.[source.id];
  return { ...options.crawl, ...sourceOptions, onProgress: options.onProgress };
}

export function crawlOptionsFor(source: SourceConfig, options: BuildCorpusOptions): CrawlSourceOptions {
  return optionsFor(source, options);
}

export function readActiveDocuments(db: Database): DocumentSnapshot[] {
  return (db.prepare('SELECT snapshot FROM documents WHERE active=1').all() as Array<{ snapshot: string }>).map(row => JSON.parse(row.snapshot) as DocumentSnapshot);
}

/** Runs the repeatable crawl -> sanitation -> deduplication -> atomic activation path. */
export async function buildCorpus(db: Database, sources: SourceConfig[], options: BuildCorpusOptions = {}): Promise<CorpusBuildReport> {
  const crawls: CrawlReport[] = [];
  const failures: CorpusBuildReport['failures'] = [];
  for (const source of sources.filter(item => item.enabled)) {
    try {
      const report = await crawlSource(db, source, optionsFor(source, options));
      crawls.push(report);
      if (report.documents.length === 0) failures.push({ sourceId: source.id, reason: 'no_accepted_documents' });
    } catch (error) {
      failures.push({ sourceId: source.id, reason: error instanceof Error ? error.message : String(error) });
      if (options.continueOnSourceError === false) throw error;
    }
  }
  const documents = crawls.flatMap(report => report.documents);
  if (documents.length === 0) throw new Error('Corpus build produced no accepted documents; current index was not changed');
  const index = buildIndex(db, documents, { version: options.version });
  return { crawls, failures, index };
}
