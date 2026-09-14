# Corpus: browse documents already collected

Start with [browse-corpus.ts](browse-corpus.ts). `browseCorpus()` builds the data returned by `GET /api/corpus` for the [browser's Corpus page](../../../web/features/corpus/README.md).

It reads active document snapshots from SQLite, filters by text, document kind or duplicate status, and returns one page of up to 100 documents. Each document includes a short text preview; the stored full text stays unchanged. Page numbers are bounded to the available results.

The result also carries the corpus version, whole-collection totals, document-kind counts, and the latest 30 collection events. Filtered result counts and whole-collection counts have different meanings. [browse-corpus.test.ts](browse-corpus.test.ts) covers browsing and pagination.

This is a read-only view. Collecting pages belongs to [crawler](../crawler/README.md), preparing searchable passages to [indexer](../indexer/README.md), and answering questions to [answer](../answer/README.md).
