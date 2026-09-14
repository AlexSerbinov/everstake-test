# SQLite: where the application keeps its state

Start with [database.ts](database.ts): `openDatabase()` opens `DB_PATH` (default `data/knowledge.sqlite`), applies the schema, and sets a five-second busy timeout. Tests can use `:memory:`. `getSetting()` and `setSetting()` read and write small named settings.

[schema.sql](schema.sql) explains each table beside its definition:

| Stored information | Tables |
| --- | --- |
| Source snapshots, passages, word index, and vectors | `documents`, `chunks`, `chunks_fts`, `embeddings` |
| Operations, individual provider attempts, and returned answers | `runs`, `api_calls`, `answers` |
| Saved evaluation results | `evaluations` |
| Settings, collection events, and resumable transcription jobs | `settings`, `crawl_events`, `youtube_jobs` |

The [application](../application.ts) passes one database connection to its feature modules. This folder holds the schema and opening helpers; SQL queries stay beside the feature that uses them. [database.test.ts](database.test.ts) checks schema and setting behavior.

The mutable database lives under `data/`, outside Git. A document's `active` flag selects the serving collection without deleting older snapshots. Whole-corpus replacement and backups belong to [workflows](../workflows/README.md), not to `openDatabase()`.
