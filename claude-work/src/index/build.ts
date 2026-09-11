// Canonical documents → chunks (instruction sentences removed) → FTS5 (via trigger) → embeddings.

import { getConfig } from "../config.js";
import { all, floatsToBlob, run, transaction } from "../db.js";
import { embed, embeddingsEnabled } from "../embeddings.js";
import { isAiDirectedPath, stripInstructions } from "./instructions.js";

export function chunkText(text: string): string[] {
  const { target_chars, overlap_chars, min_chars } = getConfig().chunking;
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur.length + p.length + 1 > target_chars && cur.length >= min_chars) {
      chunks.push(cur);
      cur = cur.slice(Math.max(0, cur.length - overlap_chars)) + "\n" + p; // keep tail as overlap
    } else cur = cur ? cur + "\n" + p : p;
    // very long paragraph → hard split
    while (cur.length > target_chars * 1.5) { chunks.push(cur.slice(0, target_chars)); cur = cur.slice(target_chars - overlap_chars); }
  }
  if (cur.length >= min_chars || (chunks.length === 0 && cur.length > 0)) chunks.push(cur);
  return chunks;
}

export async function buildIndex(opts: { force?: boolean }) {
  const cfg = getConfig();
  const docs = all<{ id: number; url: string; final_url: string; text: string; chunks: number }>(
    `SELECT d.id, d.url, d.final_url, d.text, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) chunks
     FROM documents d WHERE d.status = 'ok' AND d.duplicate_of IS NULL ORDER BY d.id`);
  let made = 0, stripped = 0, docsDone = 0;
  const pending: { id: number; text: string }[] = [];

  for (const d of docs) {
    if (d.chunks > 0 && !opts.force) continue;
    transaction(() => {
      run("DELETE FROM chunks WHERE doc_id = ?", d.id);
      run("DELETE FROM instructions WHERE doc_id = ?", d.id);
      let docHits = 0;
      chunkText(d.text).forEach((raw, idx) => {
        const { text, hits } = stripInstructions(raw);
        docHits += hits.length;
        for (const h of hits) run("INSERT INTO instructions (doc_id, chunk_idx, sentence, pattern) VALUES (?,?,?,?)", d.id, idx, h.sentence, h.pattern);
        if (text.length < 40) return; // chunk was (almost) entirely instructions
        const r = run("INSERT INTO chunks (doc_id, idx, text, chars, instruction_hits) VALUES (?,?,?,?,?)", d.id, idx, text, text.length, hits.length);
        pending.push({ id: Number(r.lastInsertRowid), text });
        made++;
      });
      stripped += docHits;
      const aiDirected = isAiDirectedPath(d.final_url ?? d.url) || docHits >= cfg.instructions.ai_directed_min_hits ? 1 : 0;
      run("UPDATE documents SET ai_directed = ?, instruction_hits = ? WHERE id = ?", aiDirected, docHits, d.id);
    });
    docsDone++;
  }
  console.log(`chunked ${docsDone} documents → ${made} chunks; ${stripped} AI-directed sentences moved to instructions table`);

  if (!embeddingsEnabled()) { console.log("embeddings: provider=none → BM25-only retrieval"); return; }
  const todo = opts.force ? pending : all<{ id: number; text: string }>("SELECT id, text FROM chunks WHERE embedding IS NULL");
  console.log(`embedding ${todo.length} chunks…`);
  for (let i = 0; i < todo.length; i += 64) {
    const batch = todo.slice(i, i + 64);
    const vecs = await embed(batch.map((b) => b.text.slice(0, 8000)), "document");
    transaction(() => { batch.forEach((b, j) => run("UPDATE chunks SET embedding = ? WHERE id = ?", floatsToBlob(vecs[j]), b.id)); });
    if ((i / 64) % 10 === 0) process.stdout.write(`  ${Math.min(i + 64, todo.length)}/${todo.length}\r`);
  }
  console.log(`\nembeddings done`);
}
