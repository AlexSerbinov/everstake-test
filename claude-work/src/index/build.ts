// Pipeline: crawl → dedup → **index/build** → facts → retrieve → answer → eval.
//
// Turns canonical documents into the two things retrieval actually queries: rows in `chunks`
// (which a SQLite trigger mirrors into the FTS5 table for BM25) and an embedding blob on each of
// those rows (for cosine search). Aliases are skipped, so nine copies of one press release
// contribute one set of chunks — that is what stops syndication from looking like corroboration.
//
// Two side effects belong to this step and nothing else does them: sentences addressed to AI
// assistants are cut out of the chunk text into the `instructions` table (see instructions.ts),
// and `documents.ai_directed` is set for pages written for machines so the ranker can weight
// them down.
//
// If chunking is wrong, retrieval degrades invisibly: chunks too large and the embedding is an
// average of several topics, too small and a fact loses the context that makes it citable.

import { getConfig } from "../config.js";
import { all, floatsToBlob, run, transaction } from "../db.js";
import { embed, embeddingsEnabled } from "../embeddings.js";
import { isAiDirectedPath, stripInstructions } from "./instructions.js";

// A chunk left this short after stripping was essentially all instructions; indexing it would put
// a fragment with no standalone meaning into the retrievable set.
const MIN_CHUNK_CHARS_AFTER_STRIP = 40;

// Embedding providers charge and rate-limit per request, not per text, so chunks go up in
// batches. 64 is a round value that stays well inside both OpenAI's and Voyage's per-request
// limits; hand-tuned, no measurement backs the exact number.
const EMBED_BATCH_SIZE = 64;

// Providers reject over-long inputs, and a chunk is ~2800 chars anyway, so this only ever trims
// the pathological hard-split case below.
const EMBED_INPUT_CHAR_CAP = 8000;

// Progress line every N batches — often enough to see movement on a 4000-chunk run, rare enough
// not to flood a CI log.
const PROGRESS_EVERY_N_BATCHES = 10;

/**
 * Split a document into overlapping, paragraph-aligned chunks.
 *
 * Paragraphs are the unit because breaking mid-sentence gives the embedding half a thought.
 * Sizes come from config/kb.yaml: `target_chars` 2800 (≈700 tokens — big enough to hold a claim
 * with the sentences that qualify it, small enough that a top-k of 8 still fits a context
 * window), `overlap_chars` 400 (the tail of one chunk repeats at the head of the next, so a fact
 * that straddles a boundary is retrievable from either side), `min_chars` 200 (below that a chunk
 * is a heading or a caption and pollutes BM25).
 */
export function chunkText(text: string): string[] {
  const { target_chars, overlap_chars, min_chars } = getConfig().chunking;
  const paragraphs = text.split(/\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const wouldOverflow = current.length + paragraph.length + 1 > target_chars;
    if (wouldOverflow && current.length >= min_chars) {
      chunks.push(current);
      // Carry the last `overlap_chars` of the finished chunk into the next one.
      current = current.slice(Math.max(0, current.length - overlap_chars)) + "\n" + paragraph;
    } else {
      current = current ? current + "\n" + paragraph : paragraph;
    }

    // A single paragraph can be longer than a chunk (docs tables, transcript blocks). 1.5× is the
    // point at which we stop waiting for a paragraph boundary and cut mid-text; arbitrary tuning.
    while (current.length > target_chars * 1.5) {
      chunks.push(current.slice(0, target_chars));
      current = current.slice(target_chars - overlap_chars);
    }
  }

  // The trailing remainder is kept if it stands on its own — or unconditionally when it is the
  // only thing we have, so a 50-char document still produces one chunk instead of none.
  if (current.length >= min_chars || (chunks.length === 0 && current.length > 0)) chunks.push(current);
  return chunks;
}

/**
 * (Re)build chunks and embeddings for every canonical document. Incremental by default — a
 * document that already has chunks is skipped, so this can be run after each crawl — and
 * `force` re-does everything, which is what a chunking or pattern change requires.
 */
export async function buildIndex(opts: { force?: boolean }) {
  const cfg = getConfig();
  const docs = all<{ id: number; url: string; final_url: string; text: string; chunks: number }>(
    `SELECT d.id, d.url, d.final_url, d.text, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) chunks
     FROM documents d WHERE d.status = 'ok' AND d.duplicate_of IS NULL ORDER BY d.id`);

  let made = 0, stripped = 0, docsDone = 0;
  // Chunks written in this run, so `--force` can re-embed exactly them without a second query.
  const pending: { id: number; text: string }[] = [];

  for (const doc of docs) {
    if (doc.chunks > 0 && !opts.force) continue;
    const written = rewriteDocumentChunks(doc, cfg.instructions.ai_directed_min_hits, pending);
    made += written.chunksMade;
    stripped += written.instructionHits;
    docsDone++;
  }
  console.log(`chunked ${docsDone} documents → ${made} chunks; ${stripped} AI-directed sentences moved to instructions table`);

  if (!embeddingsEnabled()) { console.log("embeddings: provider=none → BM25-only retrieval"); return; }
  // Without --force, pick up anything still unembedded from earlier interrupted runs too.
  const todo = opts.force ? pending : all<{ id: number; text: string }>("SELECT id, text FROM chunks WHERE embedding IS NULL");
  await embedChunks(todo);
}

/**
 * Replace one document's chunks and instruction rows in a single transaction: a crash between
 * the DELETE and the INSERTs would leave a canonical document with no chunks, i.e. silently
 * unanswerable, and the old instruction rows would point at chunk indexes that no longer exist.
 */
function rewriteDocumentChunks(
  doc: { id: number; url: string; final_url: string; text: string },
  aiDirectedMinHits: number,
  pending: { id: number; text: string }[],
): { chunksMade: number; instructionHits: number } {
  let chunksMade = 0;
  let instructionHits = 0;

  transaction(() => {
    run("DELETE FROM chunks WHERE doc_id = ?", doc.id);
    run("DELETE FROM instructions WHERE doc_id = ?", doc.id);

    chunkText(doc.text).forEach((rawChunk, chunkIdx) => {
      const { text, hits } = stripInstructions(rawChunk);
      instructionHits += hits.length;
      for (const hit of hits) {
        run("INSERT INTO instructions (doc_id, chunk_idx, sentence, pattern) VALUES (?,?,?,?)",
          doc.id, chunkIdx, hit.sentence, hit.pattern);
      }
      // The hit rows above are still written — we keep the evidence even when the chunk is gone.
      if (text.length < MIN_CHUNK_CHARS_AFTER_STRIP) return;

      const inserted = run("INSERT INTO chunks (doc_id, idx, text, chars, instruction_hits) VALUES (?,?,?,?,?)",
        doc.id, chunkIdx, text, text.length, hits.length);
      pending.push({ id: Number(inserted.lastInsertRowid), text });
      chunksMade++;
    });

    // A page is "written for machines" either by its URL (/ai-info, /llms.txt) or by carrying
    // enough directives to amount to the same thing. The ranker multiplies such pages by 0.8:
    // a self-declaration is citable, but never as strong as an ordinary page saying the same.
    const aiDirected = isAiDirectedPath(doc.final_url ?? doc.url) || instructionHits >= aiDirectedMinHits ? 1 : 0;
    run("UPDATE documents SET ai_directed = ?, instruction_hits = ? WHERE id = ?", aiDirected, instructionHits, doc.id);
  });

  return { chunksMade, instructionHits };
}

/** Embed chunks in batches and store each vector as a float32 blob on its chunk row. */
async function embedChunks(todo: { id: number; text: string }[]): Promise<void> {
  console.log(`embedding ${todo.length} chunks…`);
  for (let i = 0; i < todo.length; i += EMBED_BATCH_SIZE) {
    const batch = todo.slice(i, i + EMBED_BATCH_SIZE);
    // "document" side of the asymmetric embedding models — the query side is used in retrieval.
    const vectors = await embed(batch.map((chunk) => chunk.text.slice(0, EMBED_INPUT_CHAR_CAP)), "document");
    // One transaction per batch, so an interrupted run leaves whole batches done and the
    // `embedding IS NULL` query above resumes exactly where it stopped.
    transaction(() => {
      batch.forEach((chunk, indexInBatch) => {
        run("UPDATE chunks SET embedding = ? WHERE id = ?", floatsToBlob(vectors[indexInBatch]), chunk.id);
      });
    });
    if ((i / EMBED_BATCH_SIZE) % PROGRESS_EVERY_N_BATCHES === 0) {
      process.stdout.write(`  ${Math.min(i + EMBED_BATCH_SIZE, todo.length)}/${todo.length}\r`);
    }
  }
  console.log(`\nembeddings done`);
}
