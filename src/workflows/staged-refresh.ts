import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { backup } from "node:sqlite";
import {
  openDatabase,
  getSetting,
  setSetting,
  type Database,
} from "../storage/database.js";
import type { SourceConfig } from "../contracts.js";
import type { EmbeddingClient } from "../providers/model-client.js";
import { embedCorpus } from "../services/search/hybrid-search.js";
import { refreshCorpus, type CorpusRefreshReport } from "./refresh-corpus.js";

export interface RefreshJob {
  id: string;
  status: "running" | "completed" | "failed";
  phase: "crawl" | "embedding" | "activation" | "done";
  sourceIds: string[];
  stagePath: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
}
const leaseKey = "refresh_lease";

function claimLease(db: Database, id: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const lease = JSON.parse(getSetting(db, leaseKey, "null")) as {
      id: string;
      expires: number;
    } | null;
    if (lease && lease.expires > Date.now())
      throw new Error("Another refresh is active");
    setSetting(
      db,
      leaseKey,
      JSON.stringify({ id, expires: Date.now() + 180_000 }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Changes documents, text index, vectors and corpus version in one SQLite transaction. */
export function activateStagedCorpus(db: Database, stagePath: string): void {
  db.prepare("ATTACH DATABASE ? AS incoming").run(stagePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM embeddings; DELETE FROM documents;
    INSERT INTO documents SELECT * FROM incoming.documents;
    INSERT INTO chunks SELECT * FROM incoming.chunks;
    INSERT INTO chunks_fts SELECT * FROM incoming.chunks_fts;
    INSERT INTO embeddings SELECT * FROM incoming.embeddings;
    INSERT INTO settings(key,value) SELECT key,value FROM incoming.settings WHERE key='corpus_version'
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("DETACH DATABASE incoming");
  }
}

export function dueSources(
  db: Database,
  sources: SourceConfig[],
  now = Date.now(),
): SourceConfig[] {
  return sources.filter((source) => {
    const checked = Date.parse(getSetting(db, `source_checked:${source.id}`));
    const intervalHours = source.authority === 1 ? 24 : 168;
    return (
      !Number.isFinite(checked) || now - checked >= intervalHours * 3600_000
    );
  });
}

/** Durable job state and staging keep the serving corpus intact through crawl/model failures. */
export async function stagedRefresh(
  db: Database,
  sources: SourceConfig[],
  client: EmbeddingClient,
  runId: string,
  options: { resumeJobId?: string; collect?: typeof refreshCorpus } = {},
) {
  const previous = options.resumeJobId
    ? (JSON.parse(
        getSetting(db, `refresh_job:${options.resumeJobId}`, "null"),
      ) as RefreshJob | null)
    : null;
  if (options.resumeJobId && !previous)
    throw new Error("Refresh job not found");
  if (previous?.status === "completed")
    throw new Error("Refresh job is already complete");
  const selected = previous
    ? sources.filter((s) => previous.sourceIds.includes(s.id))
    : sources;
  if (!selected.length) throw new Error("No configured sources selected");
  const id = previous?.id ?? randomUUID();
  claimLease(db, id);
  const directory = resolve("data/staging");
  mkdirSync(directory, { recursive: true });
  const job: RefreshJob = previous ?? {
    id,
    status: "running",
    phase: "crawl",
    sourceIds: selected.map((s) => s.id),
    stagePath: resolve(directory, `${id}.sqlite`),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!job.stagePath.startsWith(directory + "/"))
    throw new Error("Invalid staging path");
  const save = () => {
    job.updatedAt = new Date().toISOString();
    setSetting(db, `refresh_job:${id}`, JSON.stringify(job));
  };
  job.status = "running";
  delete job.error;
  save();
  const heartbeat = setInterval(
    () =>
      setSetting(
        db,
        leaseKey,
        JSON.stringify({ id, expires: Date.now() + 180_000 }),
      ),
    30_000,
  );
  heartbeat.unref();
  let staged: Database | undefined;
  let report: CorpusRefreshReport | null =
    previous && previous.phase !== "crawl"
      ? JSON.parse(readFileSync(resolve(directory, `${id}.json`), "utf8"))
      : null;
  try {
    if (!previous) await backup(db, job.stagePath);
    staged = openDatabase(job.stagePath);
    if (job.phase === "crawl") {
      const oldVersion = getSetting(staged, "corpus_version");
      report = await (options.collect ?? refreshCorpus)(staged, selected, {
        crawl: { maxPages: 1000, concurrency: 3 },
        onProgress: (event) => {
          db.prepare(
            "INSERT INTO crawl_events(url,status,reason,checked_at) VALUES(?,?,?,?)",
          ).run(
            event.url,
            event.status,
            event.reason,
            new Date().toISOString(),
          );
        },
      });
      writeFileSync(resolve(directory, `${id}.json`), JSON.stringify(report));
      if (!report.index && getSetting(staged, "corpus_version") === oldVersion)
        throw new Error(
          "Refresh collected no usable documents; previous corpus retained",
        );
      job.phase = "embedding";
      save();
    }
    const index = await embedCorpus(staged, client, runId);
    job.phase = "activation";
    save();
    staged.close();
    staged = undefined;
    activateStagedCorpus(db, job.stagePath);
    const failed = new Set(report?.failures.map((f) => f.sourceId) ?? []);
    for (const source of selected)
      if (!failed.has(source.id))
        setSetting(db, `source_checked:${source.id}`, new Date().toISOString());
    job.status = "completed";
    job.phase = "done";
    save();
    return {
      job,
      index,
      report,
      corpusVersion: getSetting(db, "corpus_version"),
    };
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  } finally {
    staged?.close();
    clearInterval(heartbeat);
    const lease = JSON.parse(getSetting(db, leaseKey, "null"));
    if (lease?.id === id) setSetting(db, leaseKey, "null");
  }
}
