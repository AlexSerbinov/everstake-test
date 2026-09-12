// One SQLite file holds everything: documents, chunks (+FTS5 +embeddings), facts,
// stripped AI-instructions, and every LLM/embedding call with its cost.
// Uses Node's built-in `node:sqlite` — no native build step anywhere.

import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";

let _db: DatabaseSync | null = null;
let _path = DB_PATH;
let _epoch = 0;

/**
 * Point the process at a different index file. The adversarial eval uses it to plant
 * poisoned documents into a copy of `kb.db` instead of the corpus everything else reads.
 * Anything caching rows keyed on `dbEpoch()` invalidates itself on the next read.
 */
export function setDbPath(file: string) {
  if (file === _path) return;
  _db?.close();
  _db = null; _path = file; _epoch++;
}
export const dbPath = () => _path;
export const dbEpoch = () => _epoch;

export function db(): DatabaseSync {
  if (_db) return _db;
  _db = new DatabaseSync(_path);
  _db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  migrate(_db);
  return _db;
}

function migrate(d: DatabaseSync) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY,
    source_id     TEXT NOT NULL,          -- id from config/sources.yaml
    url           TEXT NOT NULL UNIQUE,   -- the URL we asked for (seed)
    final_url     TEXT,                   -- after redirects
    canonical_url TEXT,                   -- <link rel=canonical> if present
    canonical_key TEXT,                   -- normalised key used for URL-level dedup
    domain        TEXT NOT NULL,
    category      TEXT NOT NULL,
    tier          INTEGER NOT NULL,
    title         TEXT,
    text          TEXT,                   -- cleaned main text (never includes <meta description>)
    meta_description TEXT,                -- kept separately: numbers here are NOT trusted
    lang          TEXT,
    published_at  TEXT,                   -- ISO date, best available
    date_source   TEXT,                   -- which signal gave published_at
    modified_at   TEXT,
    fetched_at    TEXT NOT NULL,
    http_status   INTEGER,
    html_bytes    INTEGER,
    text_chars    INTEGER,
    content_hash  TEXT,                   -- sha1 of normalised text
    status        TEXT NOT NULL DEFAULT 'ok',   -- ok | dropped
    drop_reason   TEXT,
    duplicate_of  INTEGER REFERENCES documents(id),  -- set for aliases
    dedup_method  TEXT,                   -- url | hash | minhash
    similarity    REAL,
    ai_directed   INTEGER NOT NULL DEFAULT 0,
    instruction_hits INTEGER NOT NULL DEFAULT 0,
    raw_path      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(canonical_key);
  CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);

  CREATE TABLE IF NOT EXISTS redirects (
    from_url TEXT NOT NULL, to_url TEXT NOT NULL, status INTEGER, PRIMARY KEY (from_url, to_url)
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id        INTEGER PRIMARY KEY,
    doc_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,
    text      TEXT NOT NULL,              -- instruction sentences already removed
    chars     INTEGER NOT NULL,
    embedding BLOB,                       -- float32[] little-endian
    instruction_hits INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  CREATE TABLE IF NOT EXISTS instructions (
    id       INTEGER PRIMARY KEY,
    doc_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_idx INTEGER,
    sentence TEXT NOT NULL,
    pattern  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY,
    doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    as_of      TEXT,                      -- ISO date the fact is stated to be current
    as_of_source TEXT,                    -- 'text' (explicit in sentence) | 'document' (doc published_at)
    quote      TEXT,
    confidence REAL,
    flags      TEXT                       -- e.g. 'malformed_number'
  );
  CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(key, value, quote, content='facts', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, key, value, quote) VALUES (new.id, new.key, new.value, new.quote);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, key, value, quote) VALUES ('delete', old.id, old.key, old.value, old.quote);
  END;

  CREATE TABLE IF NOT EXISTS llm_calls (
    id            INTEGER PRIMARY KEY,
    ts            TEXT NOT NULL,
    stage         TEXT NOT NULL,          -- facts | answer | judge | embed
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    latency_ms    INTEGER,
    ok            INTEGER NOT NULL DEFAULT 1,
    error         TEXT,
    meta          TEXT                    -- json
  );

  -- pages the agent fetched live during a question (fetch_live_page). Not part of the
  -- corpus: never chunked, never embedded, never ranked — only quoted with today's date.
  CREATE TABLE IF NOT EXISTS live_cache (
    url        TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,           -- ISO timestamp; entries older than agent.live_cache_minutes are refetched
    status     INTEGER,
    title      TEXT,
    text       TEXT,
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS questions_log (
    id        INTEGER PRIMARY KEY,
    ts        TEXT NOT NULL,
    question  TEXT NOT NULL,
    status    TEXT,
    mode      TEXT,
    cost_usd  REAL,
    latency_ms INTEGER,
    response  TEXT                        -- json
  );
  `);
}

export const nowIso = () => new Date().toISOString();

// --- tiny helpers so call sites stay readable ---------------------------------
export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db().prepare(sql).run(...params);
}
export function transaction<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function floatsToBlob(v: number[] | Float32Array): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}
export function blobToFloats(b: Uint8Array): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
