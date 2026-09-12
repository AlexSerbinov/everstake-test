// The data model of the whole system, and the only module that opens the database.
//
// One SQLite file (`data/kb.db`) holds every stage of the pipeline:
//   crawl    → `documents` (+ `redirects`, + the raw HTML on disk)
//   dedup    → `documents.duplicate_of` / `dedup_method` / `similarity`
//   index    → `chunks` (+ `chunks_fts` for BM25, + `chunks.embedding` for cosine)
//              and `instructions` (prompt-injection sentences cut out of the text)
//   facts    → `facts` (+ `facts_fts`)
//   ask      → `live_cache` (pages the agent fetched during a question) and `questions_log`
//   any call → `llm_calls`, the ledger every cost figure in REPORT.md §3 is computed from
//
// Why `node:sqlite` and no ORM: the schema is ~8 tables and the queries are hand-written SQL
// with FTS5 and a BLOB scan — an ORM would hide exactly the parts a reviewer needs to read,
// and `node:sqlite` is in Node 22 itself, so there is no native build step on any machine
// (REPORT.md §2.8). The price is that this module is the only guard rail: there is no
// migration tool, so the schema below must stay backward-compatible with the shipped
// `data/kb.db`. Renaming a column here does not migrate the file, it breaks it.
//
// WAL is on for concurrent readers (the HTTP server reads while a crawl writes). WAL keeps
// recent writes in a side file, so `scripts/deploy.sh` runs `PRAGMA wal_checkpoint(TRUNCATE)`
// before shipping the database — otherwise the copied `kb.db` is missing the newest rows.

import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";

let connection: DatabaseSync | null = null;
let currentPath = DB_PATH;
// Bumped on every `setDbPath`. Not a version of the schema — a generation counter for
// in-memory caches, so a cache built from the old file is not served from the new one.
let generation = 0;

/**
 * Point the process at a different index file. The adversarial eval uses it to plant
 * poisoned documents into a copy of `kb.db` instead of the corpus everything else reads.
 * Anything caching rows keyed on `dbEpoch()` invalidates itself on the next read.
 */
export function setDbPath(file: string) {
  if (file === currentPath) return;
  connection?.close();
  connection = null;
  currentPath = file;
  generation++;
}

export const dbPath = () => currentPath;
export const dbEpoch = () => generation;

/**
 * The lazily opened, process-wide connection. Lazy because importing this module must not
 * touch the disk: the tests call `setDbPath(":memory:")` at import time and would otherwise
 * create a real `kb.db` first.
 */
export function db(): DatabaseSync {
  if (connection) return connection;
  connection = new DatabaseSync(currentPath);
  // WAL: a reader (the server) never blocks the writer (a crawl) and vice versa.
  // synchronous=NORMAL: fsync per checkpoint instead of per commit. A crash can lose the last
  // transactions, which for a re-runnable crawl is cheaper than the write amplification.
  // foreign_keys=ON: off by default in SQLite, and the ON DELETE CASCADE below relies on it —
  // without this line deleting a document silently orphans its chunks and facts.
  connection.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  migrate(connection);
  return connection;
}

/**
 * Create anything missing. Every statement is `IF NOT EXISTS`, so this runs on every open and
 * is the closest thing to a migration tool here: the only supported change is adding a table
 * or an index. Order matters — FTS5 contentless-delegate tables and their triggers reference
 * the base table, so each group creates its base table before its index.
 */
function migrate(database: DatabaseSync) {
  createDocumentTables(database);
  createChunkTables(database);
  createFactTables(database);
  createOperationalTables(database);
}

/**
 * `documents`: one row per URL the crawler asked for — including the ones it later dropped or
 * folded into another document. Written by `src/crawl/crawler.ts` (and by
 * `src/eval/adversarial.ts`, which inserts fixture pages into a throw-away copy).
 * Nothing is ever deleted: a dropped page keeps its row with `status='dropped'` so the crawl
 * report can say why, and an alias keeps its row pointing at the canonical one.
 *
 * `redirects` records the hops the crawler followed, so a 301 that later flips can be seen.
 */
function createDocumentTables(database: DatabaseSync) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY,
    source_id     TEXT NOT NULL,          -- id from config/sources.yaml
    url           TEXT NOT NULL UNIQUE,   -- the URL we asked for (seed)
    final_url     TEXT,                   -- after redirects
    canonical_url TEXT,                   -- <link rel=canonical> if present
    canonical_key TEXT,                   -- normalised key used for URL-level dedup
    domain        TEXT NOT NULL,          -- host without 'www.'; the same-domain dedup key
    category      TEXT NOT NULL,          -- from the source definition: blog | docs | press | ...
    tier          INTEGER NOT NULL,       -- source authority, 1=first-party .. 3=social/ASR
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
    similarity    REAL,                   -- Jaccard/containment that justified the alias
    ai_directed   INTEGER NOT NULL DEFAULT 0,  -- page written FOR assistants (llms.txt & co)
    instruction_hits INTEGER NOT NULL DEFAULT 0, -- injection sentences found in this document
    raw_path      TEXT                    -- the untouched HTML on disk, for re-extraction
  );
  CREATE INDEX IF NOT EXISTS idx_documents_key ON documents(canonical_key);
  CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);

  CREATE TABLE IF NOT EXISTS redirects (
    from_url TEXT NOT NULL, to_url TEXT NOT NULL, status INTEGER, PRIMARY KEY (from_url, to_url)
  );
  `);
}

/**
 * `chunks`: the retrieval unit. One row per passage of a canonical document, written by
 * `src/index/build.ts`. `text` here is already cleaned of injected instruction sentences,
 * which is why the answer path can state `instructions_in_context: 0` by construction.
 *
 * The two retrieval halves live side by side: `chunks_fts` is the BM25 index and
 * `chunks.embedding` is the dense vector, scanned in-process by `src/ask/retrieve.ts`.
 *
 * `chunks_fts` is an external-content table (`content='chunks'`): FTS5 stores only the index
 * and reads the text back from `chunks` by rowid, so the corpus is not duplicated. The price
 * is that SQLite will not keep it in sync on its own — the two triggers do, and the `delete`
 * command in the AFTER DELETE trigger is FTS5's required way to retract a row.
 *
 * `instructions`: every sentence the injection filter removed, kept for the audit view rather
 * than thrown away. Also written by `src/index/build.ts`, from the same pass.
 */
function createChunkTables(database: DatabaseSync) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    id        INTEGER PRIMARY KEY,
    doc_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,           -- position within the document, for stable ordering
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
    sentence TEXT NOT NULL,               -- the removed sentence, verbatim
    pattern  TEXT NOT NULL                -- which config/kb.yaml pattern matched it
  );
  `);
}

/**
 * `facts`: the structured ledger extracted from documents by `src/index/facts.ts` (one cheap
 * model call per document). A row is a claim with its evidence — the `quote` is the source
 * sentence, so a number in an answer can always be traced back to text on a page.
 *
 * `as_of` is the point of the table: the corpus contradicts itself over time ("130+ networks"
 * on one page, a different count on another), so a fact carries the date it was true rather
 * than being overwritten. `as_of_source` says how strong that date is — 'text' means the
 * sentence stated it, 'document' means it was inherited from the page's publication date.
 *
 * `facts_fts` mirrors `chunks_fts`: external content, same two-trigger pattern, indexing the
 * key, value and quote so a keyword question can hit the ledger directly.
 */
function createFactTables(database: DatabaseSync) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY,
    doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,             -- normalised claim name, e.g. 'networks_supported'
    value      TEXT NOT NULL,             -- kept as TEXT: values are '130+', '$4.5B', dates
    as_of      TEXT,                      -- ISO date the fact is stated to be current
    as_of_source TEXT,                    -- 'text' (explicit in sentence) | 'document' (doc published_at)
    quote      TEXT,                      -- the source sentence, so the claim stays checkable
    confidence REAL,                      -- the extractor's own 0-1 score
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
  `);
}

/**
 * The three tables that are about running the system rather than about the corpus.
 *
 * `llm_calls` is the cost ledger, written by `logCall()` in `src/llm.ts` (and by
 * `src/embeddings.ts` with stage='embed') on every single provider call, successful or not.
 * The assignment asks for *measured* cost, not an estimate (§5.6), so there is exactly one
 * place that talks to a model and it always writes a row here first; `npm run cost` reads
 * this table and nothing else. Failures are rows too (`ok=0`) — a stage that mostly errors
 * has to be visible, not merely absent.
 *
 * `live_cache` holds pages the agent fetched during a question, kept deliberately outside the
 * corpus. `questions_log` is one row per answered question, which is where the per-query cost
 * and latency in the report come from.
 */
function createOperationalTables(database: DatabaseSync) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS llm_calls (
    id            INTEGER PRIMARY KEY,
    ts            TEXT NOT NULL,
    stage         TEXT NOT NULL,          -- the Stage union in llm.ts: facts|answer|agent|judge|classify|embed|other
    provider      TEXT NOT NULL,          -- anthropic | openrouter | gemini | openai | voyage
    model         TEXT NOT NULL,          -- resolved model, not the config alias (see resolveModel)
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,   -- billed ~10x cheaper than input
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,   -- billed ~1.25x input; both kept separate
    cost_usd      REAL NOT NULL DEFAULT 0,           -- computed at call time from the price table
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
    status    TEXT,                       -- answered | no_reliable_answer | error
    mode      TEXT,                       -- factual | synthesis | ...
    cost_usd  REAL,
    latency_ms INTEGER,
    response  TEXT                        -- json
  );
  `);
}

/** Single source of "now" for every stored timestamp: UTC, ISO-8601, second-comparable as a
 *  plain string, which is what lets SQLite order and range-filter dates without a date type. */
export const nowIso = () => new Date().toISOString();

// --- tiny helpers so call sites stay readable ---------------------------------
// Every one of them prepares a fresh statement per call and passes parameters positionally.
// `node:sqlite` caches prepared statements internally, and positional binding is what keeps
// crawled text and model output out of the SQL string — there is no string interpolation of
// user or page data anywhere in this codebase.

/** First row, or undefined. Use for aggregates and lookups by a unique key. */
export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

/** All rows, materialised. Fine here because the largest result is the chunk table
 *  (~2 000 rows); a corpus 50× bigger would want a cursor instead. */
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: any[]) {
  return db().prepare(sql).run(...params);
}

/**
 * Run `body` inside one transaction. Used where a stage writes thousands of rows (indexing,
 * fact extraction): per-statement commits would fsync per row and turn a minute into an hour.
 * Not re-entrant — SQLite has no nested BEGIN, so calling this inside itself throws.
 */
export function transaction<T>(body: () => T): T {
  const database = db();
  database.exec("BEGIN");
  try {
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Embedding vector → BLOB, for `chunks.embedding`. Stored as raw little-endian float32 (the
 * platform layout, unconverted) rather than JSON: 1 536 dims are 6 KB as bytes versus ~30 KB
 * as text, and reading them back is a view over the buffer instead of a parse. The trade-off
 * is that the file is not portable to a big-endian machine — none exist in this deployment.
 */
export function floatsToBlob(values: number[] | Float32Array): Uint8Array {
  const floats = values instanceof Float32Array ? values : Float32Array.from(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

/** BLOB → vector. A view onto the same memory, not a copy — cheap, but it means the returned
 *  array must not be mutated, since `retrieve.ts` caches these across queries. */
export function blobToFloats(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
