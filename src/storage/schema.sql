PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Versioned document snapshots; active marks the serving corpus. Old revisions remain inspectable.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_url ON documents(url);

-- Searchable passages retain their parent document and position within it.
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  text TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);

-- SQLite maintains lexical search; numeric IDs alone are not evidence of support.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');

-- One measured operation, such as a question, indexing pass, or evaluation.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

-- One row per provider attempt, including failures. NULL usage or cost means unknown, never zero.
CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  stage TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  elapsed_ms REAL NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  status TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

-- Small persisted settings include corpus version, update jobs, schedules, and refresh leases.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Records accepted and excluded URLs so collection gaps can be explained.
CREATE TABLE IF NOT EXISTS crawl_events (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- Saved answer payloads include citations, checks, corpus version, and receipt.
CREATE TABLE IF NOT EXISTS answers (
  run_id TEXT PRIMARY KEY,
  result TEXT NOT NULL
);

-- Saved evaluation runs are read by the UI; they are not answering evidence.
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  result TEXT NOT NULL
);

-- Durable provider job IDs prevent duplicate transcription charges after a restart.
CREATE TABLE IF NOT EXISTS youtube_jobs (
  video_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Vectors belong to both a passage and a model. Different models are never interchangeable.
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vector TEXT NOT NULL,
  PRIMARY KEY(chunk_id,model)
);
