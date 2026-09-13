import { createHash } from "node:crypto";
import type { DocumentSnapshot } from "../../contracts.js";
import type { EmbeddingClient } from "../../providers/model-client.js";
import { openDatabase, type Database } from "../../storage/database.js";
import { buildIndex, type BuildIndexReport } from "../indexer/build-index.js";
import { embedCorpus } from "../search/hybrid-search.js";

const SOURCE_ID = "youtube-inventory";
const EMBEDDING_MODEL = "text-embedding-3-small";

export interface ReviewedActivationResult {
  index: BuildIndexReport;
  embeddings: Awaited<ReturnType<typeof embedCorpus>>;
}

/** Builds and embeds an isolated snapshot, then changes the serving source in one transaction. */
export async function activateReviewedYouTube(
  live: Database,
  documents: DocumentSnapshot[],
  client: EmbeddingClient,
  runId: string,
): Promise<ReviewedActivationResult> {
  validateDocuments(documents);
  const stage = openDatabase(":memory:");
  try {
    const index = buildIndex(stage, documents, { sourceIds: [SOURCE_ID] });
    seedCachedEmbeddings(live, stage, EMBEDDING_MODEL);
    // The client is metered against the live DB, while vectors are written only to staging.
    const embeddings = await embedCorpus(stage, client, runId, EMBEDDING_MODEL);
    assertEmbeddingCoverage(stage, embeddings.model);
    index.version = combinedVersion(live, stage);
    activateSource(live, stage, index.version);
    return { index, embeddings };
  } finally {
    stage.close();
  }
}

function seedCachedEmbeddings(
  live: Database,
  stage: Database,
  model: string,
): void {
  const find = live.prepare(
    "SELECT vector FROM embeddings WHERE chunk_id=? AND model=?",
  );
  const insert = stage.prepare(
    "INSERT INTO embeddings(chunk_id,model,vector) VALUES(?,?,?)",
  );
  const chunks = stage.prepare("SELECT id FROM chunks").all() as Array<{
    id: string;
  }>;
  for (const chunk of chunks) {
    const cached = find.get(chunk.id, model) as { vector: string } | undefined;
    if (cached) insert.run(chunk.id, model, cached.vector);
  }
}

function combinedVersion(live: Database, stage: Database): string {
  const retained = live
    .prepare(
      "SELECT id,content_hash,snapshot FROM documents WHERE active=1 AND (json_extract(snapshot, '$.metadata.sourceId') IS NULL OR json_extract(snapshot, '$.metadata.sourceId')<>?)",
    )
    .all(SOURCE_ID) as Array<Record<string, string>>;
  const incoming = stage
    .prepare(
      "SELECT id,content_hash,snapshot FROM documents WHERE active=1",
    )
    .all() as Array<Record<string, string>>;
  const digest = createHash("sha256")
    .update(
      [...retained, ...incoming]
        .map((row) => JSON.stringify([row.id, row.content_hash, row.snapshot]))
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
  return `corpus-${digest}`;
}

function validateDocuments(documents: DocumentSnapshot[]): void {
  if (
    !documents.length ||
    documents.some(
      (document) =>
        document.kind !== "youtube" ||
        document.metadata.reviewStatus !== "reviewed" ||
        document.metadata.sourceId !== SOURCE_ID,
    )
  )
    throw new Error("Only reviewed YouTube testimony can be activated");
}

function assertEmbeddingCoverage(db: Database, model: string): void {
  const missing = db
    .prepare(
      `SELECT count(*) AS count FROM chunks c
       LEFT JOIN embeddings e ON e.chunk_id=c.id AND e.model=?
       WHERE e.chunk_id IS NULL`,
    )
    .get(model) as { count: number };
  if (missing.count)
    throw new Error(`Staged YouTube index lacks ${missing.count} embeddings`);
}

function activateSource(live: Database, stage: Database, version: string): void {
  const documents = stage
    .prepare("SELECT id,url,content_hash,snapshot FROM documents WHERE active=1")
    .all() as Array<Record<string, string>>;
  const chunks = stage
    .prepare("SELECT id,document_id,text,ordinal FROM chunks ORDER BY document_id,ordinal")
    .all() as Array<Record<string, string | number>>;
  const embeddings = stage
    .prepare("SELECT chunk_id,model,vector FROM embeddings")
    .all() as Array<Record<string, string>>;
  const deactivate = live.prepare(
    "UPDATE documents SET active=0 WHERE active=1 AND json_extract(snapshot, '$.metadata.sourceId')=?",
  );
  const upsertDocument = live.prepare(`
    INSERT INTO documents(id,url,content_hash,active,snapshot) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url,content_hash=excluded.content_hash,active=excluded.active,snapshot=excluded.snapshot`);
  const deleteFts = live.prepare(
    "DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE document_id=?)",
  );
  const deleteChunks = live.prepare("DELETE FROM chunks WHERE document_id=?");
  const insertChunk = live.prepare(
    "INSERT INTO chunks(id,document_id,text,ordinal) VALUES(?,?,?,?)",
  );
  const insertFts = live.prepare("INSERT INTO chunks_fts(id,text) VALUES(?,?)");
  const insertEmbedding = live.prepare(
    "INSERT OR REPLACE INTO embeddings(chunk_id,model,vector) VALUES(?,?,?)",
  );
  live.exec("BEGIN IMMEDIATE");
  try {
    deactivate.run(SOURCE_ID);
    for (const document of documents) {
      upsertDocument.run(
        document.id,
        document.url,
        document.content_hash,
        1,
        document.snapshot,
      );
      deleteFts.run(document.id);
      deleteChunks.run(document.id);
    }
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, chunk.document_id, chunk.text, chunk.ordinal);
      insertFts.run(chunk.id, chunk.text);
    }
    for (const embedding of embeddings)
      insertEmbedding.run(embedding.chunk_id, embedding.model, embedding.vector);
    live.prepare(
      "INSERT INTO settings(key,value) VALUES('corpus_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(version);
    live.exec("COMMIT");
  } catch (error) {
    live.exec("ROLLBACK");
    throw error;
  }
}
