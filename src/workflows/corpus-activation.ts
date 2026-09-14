// Validate and publish a prepared snapshot in one transaction. Requests must never
// see new text paired with the previous corpus's vectors or version.
import { existsSync } from "node:fs";
import type { Database } from "../storage/database.js";
import { loadModelsConfig } from "../providers/provider-config.js";
import { assertLeaseOwner, type RefreshLease } from "./refresh-lease.js";

export interface CorpusState {
  version: string;
  activeDocuments: number;
  activeChunks: number;
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

export function assertCorpusState(
  actual: CorpusState,
  expected: CorpusState,
): void {
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

export function assertEmbeddingCoverage(
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

export function assertDatabaseIntegrity(
  db: Database,
  schema: "main" | "incoming" = "main",
): void {
  const result = db.prepare(`PRAGMA ${schema}.quick_check`).get();
  if (result?.quick_check !== "ok")
    throw new Error("Staged corpus failed SQLite integrity validation");
}

/** Changes documents, text index, vectors and corpus version in one SQLite transaction. */
export function activateStagedCorpus(
  db: Database,
  stagePath: string,
  lease: RefreshLease,
  baseline: CorpusState,
  expected: CorpusState,
  model = loadModelsConfig().embedding,
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
      db.exec(`UPDATE documents SET active=0;
    INSERT INTO documents SELECT * FROM incoming.documents WHERE true
      ON CONFLICT(id) DO UPDATE SET active=excluded.active,
        snapshot=CASE WHEN excluded.active=1 THEN excluded.snapshot ELSE documents.snapshot END;
    DELETE FROM chunks_fts WHERE id IN (
      SELECT id FROM chunks WHERE document_id IN (SELECT id FROM incoming.documents WHERE active=1)
    );
    DELETE FROM chunks WHERE document_id IN (SELECT id FROM incoming.documents WHERE active=1);
    INSERT INTO chunks SELECT * FROM incoming.chunks WHERE true ON CONFLICT(id) DO NOTHING;
    INSERT INTO chunks_fts SELECT * FROM incoming.chunks_fts
      WHERE id NOT IN (SELECT id FROM main.chunks_fts);
    INSERT INTO embeddings SELECT * FROM incoming.embeddings WHERE true
      ON CONFLICT(chunk_id,model) DO NOTHING;
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
