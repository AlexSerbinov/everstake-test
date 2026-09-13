import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { DocumentSnapshot } from "../../contracts.js";

const metadataSchema = z
  .object({
    sourceId: z.string(),
    videoId: z.string().regex(/^[\w-]{11}$/),
    speaker: z.string().optional(),
    speakerName: z.string().optional(),
    roleAtRecording: z.string().optional(),
    speakerStatus: z.string(),
    reviewStatus: z.enum(["reviewed"]),
    recordedAt: z.string().nullable(),
    refreshStatus: z.string(),
    freshnessNote: z.string(),
  })
  .strict();

const documentSchema = z
  .object({
    id: z.string().startsWith("youtube:"),
    url: z.string().url(),
    canonicalUrl: z.string().url(),
    title: z.string().min(1),
    publisher: z.string().min(1),
    authority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: z.literal("youtube"),
    text: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.string(),
    publishedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    dateEvidence: z.string().nullable(),
    duplicateOf: z.string().nullable(),
    revision: z.string(),
    metadata: metadataSchema,
  })
  .strict();

interface TableSpec {
  name: "runs" | "api_calls" | "youtube_jobs";
  key: string;
  columns: string[];
  jsonColumns: string[];
}

const tables: TableSpec[] = [
  {
    name: "runs",
    key: "id",
    columns: ["id", "kind", "started_at", "finished_at", "status", "metadata"],
    jsonColumns: ["metadata"],
  },
  {
    name: "api_calls",
    key: "id",
    columns: [
      "id",
      "run_id",
      "stage",
      "provider",
      "model",
      "started_at",
      "elapsed_ms",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "status",
      "metadata",
    ],
    jsonColumns: ["metadata"],
  },
  {
    name: "youtube_jobs",
    key: "video_id",
    columns: ["video_id", "status", "data"],
    jsonColumns: ["data"],
  },
];

export interface YouTubeImportReport {
  dryRun: boolean;
  source: { runs: number; apiCalls: number; jobs: number; documents: number };
  insert: { runs: number; apiCalls: number; jobs: number; documents: number };
  unchanged: {
    runs: number;
    apiCalls: number;
    jobs: number;
    documents: number;
  };
  documentsInsertedInactive: number;
}

/** Merge acquisition evidence atomically. Documents remain inactive until the caller builds chunks and embeddings. */
export function importYouTube(options: {
  sourceDatabasePath: string;
  targetDatabasePath: string;
  documentsPath: string;
  dryRun?: boolean;
}): YouTubeImportReport {
  const dryRun = options.dryRun ?? false;
  const source = new DatabaseSync(options.sourceDatabasePath, {
    readOnly: true,
  });
  const target = new DatabaseSync(options.targetDatabasePath, {
    readOnly: dryRun,
  });
  try {
    requireTables(
      source,
      tables.map((table) => table.name),
    );
    requireTables(target, ["runs", "api_calls", "youtube_jobs", "documents"]);
    const documents = validateDocuments(
      z
        .array(documentSchema)
        .parse(
          JSON.parse(readFileSync(options.documentsPath, "utf8")),
        ) as DocumentSnapshot[],
    );
    const report: YouTubeImportReport = {
      dryRun,
      source: { runs: 0, apiCalls: 0, jobs: 0, documents: documents.length },
      insert: { runs: 0, apiCalls: 0, jobs: 0, documents: 0 },
      unchanged: { runs: 0, apiCalls: 0, jobs: 0, documents: 0 },
      documentsInsertedInactive: 0,
    };
    if (!dryRun) target.exec("BEGIN IMMEDIATE");
    try {
      for (const table of tables)
        mergeTable(source, target, table, report, dryRun);
      mergeDocuments(target, documents, report, dryRun);
      if (!dryRun) target.exec("COMMIT");
    } catch (error) {
      if (!dryRun) target.exec("ROLLBACK");
      throw error;
    }
    return report;
  } finally {
    source.close();
    target.close();
  }
}

function validateDocuments(documents: DocumentSnapshot[]): DocumentSnapshot[] {
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id))
      throw new Error(`Duplicate document in import payload: ${document.id}`);
    ids.add(document.id);
    const expectedHash = createHash("sha256")
      .update(document.text)
      .digest("hex");
    const expectedId = `youtube:${document.metadata.videoId}:${expectedHash.slice(0, 16)}`;
    if (document.contentHash !== expectedHash || document.id !== expectedId) {
      throw new Error(`Document integrity check failed for ${document.id}`);
    }
    const url = new URL(document.canonicalUrl);
    if (
      url.hostname !== "www.youtube.com" ||
      url.pathname !== "/watch" ||
      url.searchParams.get("v") !== document.metadata.videoId ||
      document.url !== document.canonicalUrl
    ) {
      throw new Error(`Document URL/video mismatch for ${document.id}`);
    }
  }
  return documents;
}

function mergeTable(
  source: DatabaseSync,
  target: DatabaseSync,
  spec: TableSpec,
  report: YouTubeImportReport,
  dryRun: boolean,
): void {
  const rows = source
    .prepare(
      `SELECT ${spec.columns.join(",")} FROM ${spec.name} ORDER BY ${spec.key}`,
    )
    .all() as Array<Record<string, unknown>>;
  const label =
    spec.name === "api_calls"
      ? "apiCalls"
      : spec.name === "youtube_jobs"
        ? "jobs"
        : "runs";
  report.source[label] = rows.length;
  const find = target.prepare(
    `SELECT ${spec.columns.join(",")} FROM ${spec.name} WHERE ${spec.key}=?`,
  );
  const placeholders = spec.columns.map(() => "?").join(",");
  const insert = dryRun
    ? null
    : target.prepare(
        `INSERT INTO ${spec.name}(${spec.columns.join(",")}) VALUES(${placeholders})`,
      );
  for (const row of rows) {
    const id = row[spec.key];
    const existing = find.get(String(id)) as
      Record<string, unknown> | undefined;
    if (existing) {
      if (!sameRow(existing, row, spec))
        throw new Error(`Import conflict in ${spec.name} for ${String(id)}`);
      report.unchanged[label] += 1;
      continue;
    }
    report.insert[label] += 1;
    insert?.run(...spec.columns.map((column) => row[column] as never));
  }
}

function mergeDocuments(
  target: DatabaseSync,
  documents: DocumentSnapshot[],
  report: YouTubeImportReport,
  dryRun: boolean,
): void {
  const find = target.prepare(
    "SELECT url,content_hash,snapshot FROM documents WHERE id=?",
  );
  const insert = dryRun
    ? null
    : target.prepare(
        "INSERT INTO documents(id,url,content_hash,active,snapshot) VALUES(?,?,?,0,?)",
      );
  for (const document of documents) {
    const existing = find.get(document.id) as
      { url: string; content_hash: string; snapshot: string } | undefined;
    const snapshot = JSON.stringify(document);
    if (existing) {
      if (
        existing.url !== document.url ||
        existing.content_hash !== document.contentHash ||
        canonicalJson(existing.snapshot) !== canonicalJson(snapshot)
      ) {
        throw new Error(`Import conflict in documents for ${document.id}`);
      }
      report.unchanged.documents += 1;
      continue;
    }
    report.insert.documents += 1;
    report.documentsInsertedInactive += 1;
    insert?.run(document.id, document.url, document.contentHash, snapshot);
  }
}

function sameRow(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  spec: TableSpec,
): boolean {
  return spec.columns.every((column) =>
    spec.jsonColumns.includes(column)
      ? canonicalJson(String(left[column])) ===
        canonicalJson(String(right[column]))
      : left[column] === right[column],
  );
}

function canonicalJson(value: string): string {
  return JSON.stringify(sortJson(JSON.parse(value) as unknown));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function requireTables(db: DatabaseSync, names: string[]): void {
  for (const name of names) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    if (!row) throw new Error(`Required table is missing: ${name}`);
  }
}
