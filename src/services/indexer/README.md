# Indexer

Builds the searchable SQLite snapshot from extracted documents.
Start with `build-index.ts`; duplicate grouping is in `deduplicate.ts` and section-aware chunking is in `chunk.ts`.
Input is a complete or source-scoped list of `DocumentSnapshot` objects.
Output is an activated corpus version, duplicate groups, and stable FTS-backed chunks.
Every URL and revision remains in `documents`; copies share a group and only the representative contributes chunks.
Activation is one transaction, so a failed rebuild leaves the previous corpus active.
Tests cover duplicate revisions, chunk boundaries, persistence, and rollback.
