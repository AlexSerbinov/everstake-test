# Corpus snapshots

Crawl reports and the frozen manifest record which sources were collected, excluded, or unavailable in a saved corpus run. They preserve provenance for the evaluation.

These are exported records, not the live searchable database. See [CORPUS.md](../../docs/CORPUS.md) for the collection policy and results.

## Open a record

- [Frozen manifest](frozen-manifest.json): document IDs, URLs, content hashes and source dates, plus saved corpus counts. It identifies the snapshot; it does not contain every document's full text.
- [Collection run 32085c77](32085c77-a255-40ab-b3f8-c91f97d83993.json) and [collection run 707fca2a](707fca2a-2f0f-421b-bfc5-e3c2daabb8e9.json): crawl results, failures, retained sources and indexing results. The long filenames are run IDs, not separate source categories.

Match the corpus version in a saved evaluation to its manifest before comparing results. These exports alone do not recreate a searchable SQLite database.
