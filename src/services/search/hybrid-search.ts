import type { Database } from "../../storage/database.js";
import { loadModelsConfig } from "../../providers/provider-config.js";
import type { EmbeddingClient } from "../../providers/model-client.js";
import type { DocumentSnapshot, EvidencePassage } from "../../contracts.js";
import { passage, searchCorpus } from "./search-corpus.js";
// Batch size bounds each embedding request; rank smoothing keeps top lexical and
// semantic hits comparable even though their raw scores use different scales.
const EMBEDDING_BATCH_SIZE = 64;
const RANK_SMOOTHING = 60;

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    magnitudeA = 0,
    magnitudeB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magnitudeA += a[i]! ** 2;
    magnitudeB += b[i]! ** 2;
  }
  return magnitudeA && magnitudeB
    ? dot / Math.sqrt(magnitudeA * magnitudeB)
    : 0;
}
export async function embedCorpus(
  db: Database,
  client: EmbeddingClient,
  runId: string,
  model = loadModelsConfig().embedding,
) {
  const rows = db
    .prepare(
      `SELECT c.id,c.text FROM chunks c JOIN documents d ON d.id=c.document_id
 LEFT JOIN embeddings e ON e.chunk_id=c.id AND e.model=? WHERE d.active=1 AND e.chunk_id IS NULL`,
    )
    .all(model) as { id: string; text: string }[];
  let dimensions = activeVectors(db, model)[0]?.vector.length;
  let indexed = 0;
  for (let offset = 0; offset < rows.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const result = await client.embed({
      runId,
      stage: "index",
      input: batch.map((r) => r.text),
      model,
    });
    if (result.embeddings.length !== batch.length)
      throw new Error("Embedding count does not match batch");
    if (result.model !== model)
      throw new Error(
        `Embedding provider returned ${result.model}; requested ${model}`,
      );
    for (const vector of result.embeddings) {
      validateVector(vector, dimensions);
      dimensions ??= vector.length;
    }
    db.exec("BEGIN");
    try {
      for (let i = 0; i < batch.length; i++)
        db.prepare(
          "INSERT OR REPLACE INTO embeddings(chunk_id,model,vector) VALUES(?,?,?)",
        ).run(batch[i]!.id, result.model, JSON.stringify(result.embeddings[i]));
      db.exec("COMMIT");
      vectorCache.delete(db);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    indexed += batch.length;
    console.log(`Embedded ${indexed}/${rows.length} new chunks`);
  }
  return {
    indexed,
    cached:
      Number(
        db
          .prepare("SELECT count(*) AS n FROM embeddings WHERE model=?")
          .get(model)!.n,
      ) - indexed,
    model,
  };
}
interface VectorRow {
  id: string;
  text: string;
  snapshot: string;
  vector: Float32Array;
}
const vectorCache = new WeakMap<Database, { key: string; rows: VectorRow[] }>();

/**
 * Parsed corpus vectors are kept per database and corpus version. Re-parsing ~7,700 JSON
 * vectors for every search costs seconds and, when several searches run at once, exhausts
 * the heap; one typed-array copy per corpus version is small and reused until the corpus
 * changes.
 */
export function activeVectors(db: Database, model: string): VectorRow[] {
  const version = String(
    db.prepare("SELECT value FROM settings WHERE key='corpus_version'").get()
      ?.value ?? "unbuilt",
  );
  const key = `${version}:${model}`;
  const cached = vectorCache.get(db);
  if (cached?.key === key) return cached.rows;
  const stored = db
    .prepare(
      `SELECT c.id,c.text,e.vector,d.snapshot FROM embeddings e JOIN chunks c ON c.id=e.chunk_id
     JOIN documents d ON d.id=c.document_id WHERE d.active=1 AND e.model=?`,
    )
    .all(model) as {
    id: string;
    text: string;
    vector: string;
    snapshot: string;
  }[];
  let dimensions: number | undefined;
  const rows = stored.map((row) => {
    const vector: unknown = JSON.parse(row.vector);
    validateVector(vector, dimensions);
    dimensions ??= vector.length;
    return { ...row, vector: Float32Array.from(vector) };
  });
  vectorCache.set(db, { key, rows });
  return rows;
}

export async function hybridSearch(
  db: Database,
  client: EmbeddingClient,
  runId: string,
  query: string,
  limit = 12,
  model = loadModelsConfig().embedding,
): Promise<EvidencePassage[]> {
  const lexical = searchCorpus(db, query, 30);
  const rows = activeVectors(db, model);
  if (!rows.length) {
    const otherModel = db
      .prepare(
        `SELECT e.model FROM embeddings e JOIN chunks c ON c.id=e.chunk_id
       JOIN documents d ON d.id=c.document_id WHERE d.active=1 AND e.model<>? LIMIT 1`,
      )
      .get(model);
    if (otherModel)
      throw new Error(
        `No active vectors for ${model}; rebuild the index for the configured embedding model`,
      );
    // A corpus without any vectors can still answer lexical searches without a paid call.
    return lexical.slice(0, limit);
  }
  const embedded = await client.embed({
    runId,
    stage: "query-embedding",
    input: query,
    model,
  });
  if (embedded.model !== model)
    throw new Error(
      `Embedding provider returned ${embedded.model}; requested ${model}`,
    );
  if (embedded.embeddings.length !== 1)
    throw new Error("Query embedding must return exactly one vector");
  const vector = embedded.embeddings[0]!;
  validateVector(vector, rows[0]!.vector.length);
  const ranked = rows
    .map((r) => ({ ...r, similarity: cosine(vector, r.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 60);
  const merged = new Map<string, { evidence: EvidencePassage; rank: number }>();
  lexical.forEach((e, i) =>
    merged.set(e.id, { evidence: e, rank: 1 / (RANK_SMOOTHING + i) }),
  );
  ranked.forEach((r, i) => {
    const existing = merged.get(r.id);
    const document = JSON.parse(r.snapshot) as DocumentSnapshot;
    merged.set(r.id, {
      evidence:
        existing?.evidence ?? passage(document, r.id, r.text, r.similarity),
      rank: (existing?.rank ?? 0) + 1 / (RANK_SMOOTHING + i),
    });
  });
  return diversify([...merged.values()], limit);
}

/**
 * Fills the result window from fused rank, then reserves the last quarter of the slots for the
 * newest dated candidates among the next-ranked matches. Similarity alone would otherwise
 * bury a recently updated page under many older copies of the same wording, and the answer
 * loop cannot compare dates it never sees.
 */
export function diversify(
  candidates: { evidence: EvidencePassage; rank: number }[],
  limit: number,
): EvidencePassage[] {
  const groups = new Map<string, number>();
  const results: EvidencePassage[] = [];
  const admit = (
    row: { evidence: EvidencePassage; rank: number },
    reason: string,
  ) => {
    const e = row.evidence;
    if ((groups.get(e.duplicateGroup) ?? 0) >= 2) return;
    if (results.some((r) => r.id === e.id)) return;
    groups.set(e.duplicateGroup, (groups.get(e.duplicateGroup) ?? 0) + 1);
    results.push({ ...e, score: row.rank, reason });
  };
  const byRank = candidates.sort((a, b) => b.rank - a.rank);
  const rankSlots = Math.max(1, Math.ceil((limit * 3) / 4));
  for (const row of byRank) {
    if (results.length >= rankSlots) break;
    admit(
      row,
      "Lexical and semantic rank fusion; diversified by content group. Authority and temporal validity checked separately.",
    );
  }
  const date = (e: EvidencePassage) => e.updatedAt ?? e.publishedAt ?? "";
  // Only candidates that already rank near the window qualify: recency reorders relevant
  // matches, it does not admit unrelated pages merely because they are new.
  for (const row of byRank
    .slice(0, limit * 2)
    .filter((r) => date(r.evidence))
    .sort((a, b) => date(b.evidence).localeCompare(date(a.evidence)))) {
    if (results.length >= limit) break;
    admit(
      row,
      "Recency slot: newest dated page among the top matches, so current and historical statements can be compared.",
    );
  }
  for (const row of byRank) {
    if (results.length >= limit) break;
    admit(
      row,
      "Lexical and semantic rank fusion; diversified by content group. Authority and temporal validity checked separately.",
    );
  }
  return results;
}

/** Vectors from different models or dimensions do not share a meaningful coordinate space. */
function validateVector(
  value: unknown,
  dimensions?: number,
): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (entry) =>
        typeof entry === "number" &&
        Number.isFinite(entry) &&
        Number.isFinite(Math.fround(entry)),
    )
  )
    throw new Error(
      "Embedding vector must contain finite numbers and cannot be empty",
    );
  if (dimensions !== undefined && value.length !== dimensions)
    throw new Error(
      `Embedding dimension mismatch: expected ${dimensions}, received ${value.length}; rebuild the index`,
    );
}
