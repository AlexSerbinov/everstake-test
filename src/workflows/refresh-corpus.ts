import type { SourceConfig } from "../contracts.js";
import type { Database } from "../storage/database.js";
import {
  crawlSource,
  type CrawlReport,
} from "../services/crawler/crawl-source.js";
import {
  buildIndex,
  type BuildIndexReport,
} from "../services/indexer/build-index.js";
import {
  crawlOptionsFor,
  readActiveDocuments,
  type BuildCorpusOptions,
} from "./build-corpus.js";

export interface RefreshCorpusOptions extends BuildCorpusOptions {
  sourceIds?: string[];
}

export interface CorpusRefreshReport {
  crawls: CrawlReport[];
  failures: Array<{ sourceId: string; reason: string }>;
  retainedSourceIds: string[];
  index: BuildIndexReport | null;
  counts?: {
    added: number;
    changed: number;
    unchanged: number;
    retained: number;
    excluded: number;
    pending: number;
  };
}

/** Refreshes selected sources and retains their active snapshots when collection fails. */
export async function refreshCorpus(
  db: Database,
  sources: SourceConfig[],
  options: RefreshCorpusOptions = {},
): Promise<CorpusRefreshReport> {
  const previous = readActiveDocuments(db);
  const selected = sources.filter(
    (source) =>
      source.enabled &&
      (!options.sourceIds || options.sourceIds.includes(source.id)),
  );
  const crawls: CrawlReport[] = [];
  const failures: CorpusRefreshReport["failures"] = [];
  const successfulIds = new Set<string>();
  for (const source of selected) {
    try {
      const report = await crawlSource(
        db,
        source,
        crawlOptionsFor(source, options),
      );
      crawls.push(report);
      if (report.documents.length === 0)
        failures.push({ sourceId: source.id, reason: "no_accepted_documents" });
      else successfulIds.add(source.id);
      if (
        report.exclusions.some(
          (e) =>
            ![
              "path_excluded",
              "robots_disallowed",
              "insufficient_content",
              "unsupported_content_type",
            ].includes(e.reason),
        )
      )
        failures.push({
          sourceId: source.id,
          reason: "collection_has_exclusions_requiring_review",
        });
    } catch (error) {
      failures.push({
        sourceId: source.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (options.continueOnSourceError === false) throw error;
    }
  }
  if (successfulIds.size === 0)
    return {
      crawls,
      failures,
      retainedSourceIds: selected.map((source) => source.id),
      index: null,
    };
  const refreshed = crawls
    .filter((report) => successfulIds.has(report.sourceId))
    .flatMap((report) => report.documents);
  const refreshedKeys = new Set(
    refreshed.flatMap((document) => [document.url, document.canonicalUrl]),
  );
  const selectedIds = new Set(selected.map((s) => s.id));
  const retained = previous
    .filter(
      (document) =>
        !successfulIds.has(String(document.metadata.sourceId ?? "")) ||
        (!refreshedKeys.has(document.url) &&
          !refreshedKeys.has(document.canonicalUrl)),
    )
    .map((document) =>
      selectedIds.has(String(document.metadata.sourceId ?? ""))
        ? {
            ...document,
            metadata: {
              ...document.metadata,
              refreshStatus: "not_rechecked",
              freshnessNote:
                "Retained historical snapshot; not verified by this refresh",
            },
          }
        : document,
    );
  const index = buildIndex(db, [...retained, ...refreshed], {
    version: options.version,
  });
  const priorByUrl = new Map(previous.map((d) => [d.canonicalUrl, d]));
  const counts = {
    added: refreshed.filter((d) => !priorByUrl.has(d.canonicalUrl)).length,
    changed: refreshed.filter(
      (d) =>
        priorByUrl.has(d.canonicalUrl) &&
        priorByUrl.get(d.canonicalUrl)!.contentHash !== d.contentHash,
    ).length,
    unchanged: refreshed.filter(
      (d) => priorByUrl.get(d.canonicalUrl)?.contentHash === d.contentHash,
    ).length,
    retained: retained.length,
    excluded: crawls.reduce((n, c) => n + c.exclusions.length, 0),
    pending: crawls.reduce((n, c) => n + c.pending.length, 0),
  };
  return {
    counts,
    crawls,
    failures,
    retainedSourceIds: failures.map((failure) => failure.sourceId),
    index,
  };
}
