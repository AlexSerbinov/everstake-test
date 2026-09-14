import {
  readUpdateSettings,
  nextSourceCheck,
} from "../services/updates/settings.js";
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

import { loadModelsConfig } from "../providers/provider-config.js";
import {
  claimRefreshLease,
  renewRefreshLease,
  releaseRefreshLease,
  assertLeaseOwner,
} from "./refresh-lease.js";
import {
  inspectCorpusState,
  assertCorpusState,
  assertDatabaseIntegrity,
  assertEmbeddingCoverage,
  activateStagedCorpus,
  type CorpusState,
} from "./corpus-activation.js";
// Keep the workflow's existing public API while implementation lives by responsibility.
export {
  claimRefreshLease,
  renewRefreshLease,
  releaseRefreshLease,
} from "./refresh-lease.js";
export type { RefreshLease } from "./refresh-lease.js";
export {
  inspectCorpusState,
  activateStagedCorpus,
} from "./corpus-activation.js";
export type { CorpusState } from "./corpus-activation.js";

const heartbeatMs = 30_000;

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
  counts?: {
    added: number;
    changed: number;
    unchanged: number;
    retained: number;
    excluded: number;
    pending: number;
  };
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

export function dueSources(
  db: Database,
  sources: SourceConfig[],
  now = Date.now(),
): SourceConfig[] {
  const settings = readUpdateSettings(
    db,
    sources.map((s) => ({
      id: s.id,
      label: s.publisher,
      kind: s.kind,
      intervalHours: s.authority === 1 ? 24 : 168,
    })),
  );
  return sources.filter((source) => {
    const next = nextSourceCheck(db, source.id, settings);
    return (
      source.enabled &&
      settings.sources[source.id].enabled &&
      (!next || Date.parse(next) <= now)
    );
  });
}

/** Durable job state and staging keep the serving corpus intact through crawl/model failures. */
export async function stagedRefresh(
  db: Database,
  sources: SourceConfig[],
  client: EmbeddingClient,
  runId: string,
  options: {
    resumeJobId?: string;
    collect?: typeof refreshCorpus;
    stagingDirectory?: string;
    onPhase?: (phase: string) => void;
  } = {},
) {
  // Pin one embedding model for the complete update, including activation checks.
  const embeddingModel = loadModelsConfig().embedding;
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
  const directory = resolve(options.stagingDirectory ?? "data/staging");
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
    options.onPhase?.(job.phase);
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

    // First run: back up the serving database. Resume: reuse the same staged snapshot.
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
      job.counts = report.counts;
      writeJsonAtomic(jobReportPath, report);
      if (
        report.failures.length ||
        report.crawls.some((crawl) => crawl.pending.length > 0)
      )
        throw new Error(
          "Refresh is incomplete; previous corpus retained. Inspect exclusions and retry the source.",
        );
      if (!report.index && getSetting(staged, "corpus_version") === oldVersion)
        throw new Error(
          "Refresh collected no usable documents; previous corpus retained",
        );
      job.target = inspectCorpusState(staged);
      writeJsonAtomic(jobReportPath, report);
      job.phase = "embedding";
      save();
    }

    // External calls finish in staging before the serving corpus can change.
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
