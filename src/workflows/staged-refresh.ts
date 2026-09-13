import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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

export interface CorpusState {
  version: string;
  activeDocuments: number;
  activeChunks: number;
}

export interface RefreshJob {
  id: string;
  status: "running" | "completed" | "failed";
  phase: "crawl" | "embedding" | "activation" | "done";
  sourceIds: string[];
  stagePath: string;
  baseline: CorpusState;
  target?: CorpusState;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface RefreshLease {
  jobId: string;
  ownerToken: string;
  expires: number;
}

const leaseKey = "refresh_lease";
const leaseTtlMs = 180_000;
const heartbeatMs = 30_000;
const embeddingModel = "text-embedding-3-small";

function storedLease(db: Database): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(getSetting(db, leaseKey, "null"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function leaseMatches(
  value: Record<string, unknown> | null,
  lease: RefreshLease,
  now: number,
): boolean {
  return (
    value?.jobId === lease.jobId &&
    value.ownerToken === lease.ownerToken &&
    typeof value.expires === "number" &&
    value.expires > now
  );
}

/** Claims a cross-process lease and returns an invocation-specific fencing token. */
export function claimRefreshLease(
  db: Database,
  jobId: string,
  now = Date.now(),
  ttlMs = leaseTtlMs,
): RefreshLease {
  const lease = {
    jobId,
    ownerToken: randomUUID(),
    expires: now + ttlMs,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = storedLease(db);
    if (current && typeof current.expires === "number" && current.expires > now)
      throw new Error("Another refresh is active");
    setSetting(db, leaseKey, JSON.stringify(lease));
    db.exec("COMMIT");
    return lease;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Renews only the lease still owned by this invocation. */
export function renewRefreshLease(
  db: Database,
  lease: RefreshLease,
  now = Date.now(),
  ttlMs = leaseTtlMs,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!leaseMatches(storedLease(db), lease, now)) {
      db.exec("COMMIT");
      return false;
    }
    lease.expires = now + ttlMs;
    setSetting(db, leaseKey, JSON.stringify(lease));
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function releaseRefreshLease(
  db: Database,
  lease: RefreshLease,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = storedLease(db);
    if (
      current?.jobId !== lease.jobId ||
      current.ownerToken !== lease.ownerToken
    ) {
      db.exec("COMMIT");
      return false;
    }
    setSetting(db, leaseKey, "null");
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function assertLeaseOwner(
  db: Database,
  lease: RefreshLease,
  now = Date.now(),
): void {
  if (!leaseMatches(storedLease(db), lease, now))
    throw new Error("Refresh lease was lost; staged corpus was not activated");
}

function corpusState(
  db: Database,
  schema: "main" | "incoming" = "main",
): CorpusState {
  const version = db
    .prepare(`SELECT value FROM ${schema}.settings WHERE key='corpus_version'`)
    .get()?.value;
  const activeDocuments = Number(
    db
      .prepare(`SELECT count(*) AS n FROM ${schema}.documents WHERE active=1`)
      .get()!.n,
  );
  const activeChunks = Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM ${schema}.chunks c JOIN ${schema}.documents d ON d.id=c.document_id WHERE d.active=1`,
      )
      .get()!.n,
  );
  return {
    version: typeof version === "string" ? version : "",
    activeDocuments,
    activeChunks,
  };
}

export function inspectCorpusState(db: Database): CorpusState {
  return corpusState(db);
}

function assertCorpusState(actual: CorpusState, expected: CorpusState): void {
  if (
    actual.version !== expected.version ||
    actual.activeDocuments !== expected.activeDocuments ||
    actual.activeChunks !== expected.activeChunks
  )
    throw new Error(
      `Staged corpus is incomplete or changed: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
}

function assertLiveBaseline(actual: CorpusState, expected: CorpusState): void {
  if (
    actual.version !== expected.version ||
    actual.activeDocuments !== expected.activeDocuments ||
    actual.activeChunks !== expected.activeChunks
  )
    throw new Error(
      `Serving corpus changed since staging began: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
}

function assertEmbeddingCoverage(
  db: Database,
  schema: "main" | "incoming",
  model: string,
): void {
  const missing = Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM ${schema}.chunks c
         JOIN ${schema}.documents d ON d.id=c.document_id
         LEFT JOIN ${schema}.embeddings e ON e.chunk_id=c.id AND e.model=?
         WHERE d.active=1 AND e.chunk_id IS NULL`,
      )
      .get(model)!.n,
  );
  if (missing)
    throw new Error(
      `Staged corpus is missing ${missing} ${model} embeddings; corpus was not activated`,
    );
}

function assertDatabaseIntegrity(
  db: Database,
  schema: "main" | "incoming" = "main",
): void {
  const result = db.prepare(`PRAGMA ${schema}.quick_check`).get();
  if (result?.quick_check !== "ok")
    throw new Error("Staged corpus failed SQLite integrity validation");
}

function assertPathInside(directory: string, path: string): void {
  const child = relative(directory, path);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new Error("Invalid staging path");
}

function reportPath(directory: string, id: string): string {
  const path = resolve(directory, `${id}.json`);
  assertPathInside(directory, path);
  return path;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    writeFileSync(partial, JSON.stringify(value));
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
}

/** Changes documents, text index, vectors and corpus version in one SQLite transaction. */
export function activateStagedCorpus(
  db: Database,
  stagePath: string,
  lease: RefreshLease,
  baseline: CorpusState,
  expected: CorpusState,
  model = embeddingModel,
  now = Date.now(),
): void {
  if (!existsSync(stagePath))
    throw new Error("Staged corpus file is missing; corpus was not activated");
  db.prepare("ATTACH DATABASE ? AS incoming").run(stagePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      assertLeaseOwner(db, lease, now);
      assertLiveBaseline(corpusState(db), baseline);
      assertDatabaseIntegrity(db, "incoming");
      assertCorpusState(corpusState(db, "incoming"), expected);
      assertEmbeddingCoverage(db, "incoming", model);
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
    ? sources.filter((source) => previous.sourceIds.includes(source.id))
    : sources;
  if (!selected.length) throw new Error("No configured sources selected");

  const id = previous?.id ?? randomUUID();
  const lease = claimRefreshLease(db, id);
  const directory = resolve("data/staging");
  const job: RefreshJob = previous ?? {
    id,
    status: "running",
    phase: "crawl",
    sourceIds: selected.map((source) => source.id),
    stagePath: resolve(directory, `${id}.sqlite`),
    baseline: inspectCorpusState(db),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let jobPersisted = Boolean(previous);
  let staged: Database | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let leaseLost = false;
  let partialStagePath: string | undefined;
  const save = () => {
    job.updatedAt = new Date().toISOString();
    setSetting(db, `refresh_job:${id}`, JSON.stringify(job));
  };
  const ensureLease = () => {
    if (leaseLost) throw new Error("Refresh lease was lost");
    assertLeaseOwner(db, lease);
  };

  try {
    mkdirSync(directory, { recursive: true });
    assertPathInside(directory, job.stagePath);
    const jobReportPath = reportPath(directory, id);
    heartbeat = setInterval(() => {
      try {
        if (!renewRefreshLease(db, lease)) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, heartbeatMs);
    heartbeat.unref();

    if (!previous) {
      if (existsSync(job.stagePath))
        throw new Error("Staged corpus path already exists");
      partialStagePath = `${job.stagePath}.${lease.ownerToken}.partial`;
      await backup(db, partialStagePath);
      ensureLease();
      const snapshot = openDatabase(partialStagePath);
      try {
        assertDatabaseIntegrity(snapshot);
        assertCorpusState(inspectCorpusState(snapshot), job.baseline);
      } finally {
        snapshot.close();
      }
      renameSync(partialStagePath, job.stagePath);
      partialStagePath = undefined;
      save();
      jobPersisted = true;
    } else {
      if (!job.baseline)
        throw new Error("Refresh job lacks staging integrity metadata");
      if (!existsSync(job.stagePath))
        throw new Error("Staged corpus file is missing; resume refused");
    }

    staged = openDatabase(job.stagePath);
    assertDatabaseIntegrity(staged);
    if (job.phase === "crawl") {
      assertCorpusState(inspectCorpusState(staged), job.baseline);
    } else {
      if (!job.target)
        throw new Error("Refresh job lacks target corpus integrity metadata");
      assertCorpusState(inspectCorpusState(staged), job.target);
    }

    let report: CorpusRefreshReport | null = null;
    if (job.phase !== "crawl") {
      if (!existsSync(jobReportPath))
        throw new Error("Refresh report is missing; resume refused");
      report = JSON.parse(readFileSync(jobReportPath, "utf8"));
    }
    job.status = "running";
    delete job.error;
    save();

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
      ensureLease();
      if (!report.index && getSetting(staged, "corpus_version") === oldVersion)
        throw new Error(
          "Refresh collected no usable documents; previous corpus retained",
        );
      job.target = inspectCorpusState(staged);
      writeJsonAtomic(jobReportPath, report);
      job.phase = "embedding";
      save();
    }

    const index = await embedCorpus(staged, client, runId, embeddingModel);
    ensureLease();
    if (!job.target)
      throw new Error("Refresh job lacks target corpus integrity metadata");
    assertCorpusState(inspectCorpusState(staged), job.target);
    assertEmbeddingCoverage(staged, "main", index.model);
    job.phase = "activation";
    save();
    staged.close();
    staged = undefined;
    activateStagedCorpus(
      db,
      job.stagePath,
      lease,
      job.baseline,
      job.target,
      index.model,
    );
    const failed = new Set(
      report?.failures.map((failure) => failure.sourceId) ?? [],
    );
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
    if (jobPersisted) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      try {
        save();
      } catch {
        // Preserve the original error; an expired lease permits later recovery.
      }
    }
    throw error;
  } finally {
    staged?.close();
    if (heartbeat) clearInterval(heartbeat);
    if (partialStagePath) rmSync(partialStagePath, { force: true });
    try {
      releaseRefreshLease(db, lease);
    } catch {
      // A lease expires safely if its final cleanup write cannot complete.
    }
  }
}
