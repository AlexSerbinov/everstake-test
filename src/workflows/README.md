# Corpus workflows

Coordinates collection and index activation without adding a second ingestion path.
Start with `build-corpus.ts` for the initial corpus and `refresh-corpus.ts` for targeted updates.
Both workflows call the same crawler, sanitizer, deduplicator, chunker, and SQLite indexer.
Input is configured sources plus explicit per-source crawl limits.
Output includes crawl outcomes, exclusions, failures, duplicate groups, and the activated corpus version.
A refresh with no accepted replacement keeps the prior source snapshot active.
No paid model or embedding call occurs in these workflows.
