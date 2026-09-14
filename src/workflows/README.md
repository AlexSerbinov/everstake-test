# Collection workflows

Coordinates crawling, document preparation, and index activation for initial collection and source refreshes. The workflows reuse the feature modules rather than creating a second ingestion implementation.

A staged refresh prepares and embeds replacement evidence before activating it. Failed preparation keeps the previous corpus available; embedding calls can incur API costs. Start with [build-corpus.ts](build-corpus.ts) for initial collection and [staged-refresh.ts](staged-refresh.ts) for staged updates.

Follow a refresh in this order:

1. [staged-refresh.ts](staged-refresh.ts) creates or resumes a durable job, backs up the serving database, crawls into staging, and builds missing embeddings.
2. [refresh-lease.ts](refresh-lease.ts) claims and renews the right to publish. A unique owner token stops an expired worker from releasing a newer worker's lock.
3. [corpus-activation.ts](corpus-activation.ts) checks the baseline, target counts, database integrity, and embedding coverage, then activates text, vectors, and corpus version in one transaction.

[refresh-corpus.ts](refresh-corpus.ts) collects selected sources and merges their results with saved documents. It retains evidence from failed or incomplete collection instead of treating a partial crawl as proof that a page disappeared. The staged workflow runs this preparation in its staging database before activation.

The staging file survives a failed run for inspection/resume. The lease is released in `finally`. API usage belongs to the live accounting database even when the staged corpus cannot be published. Existing exports from [staged-refresh.ts](staged-refresh.ts) remain available to callers and tests.

The adjacent staged-refresh tests exercise failed embeddings, missing staging files, lease ownership, concurrent changes, and recovery. These checks protect stored evidence; they do not measure answer quality.
