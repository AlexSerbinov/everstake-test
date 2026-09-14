# Build the searchable index

Start at `buildIndex()` in [build-index.ts](build-index.ts). It takes collected document snapshots, groups copies, builds passages, and publishes them to SQLite. The [collection workflows](../../workflows/README.md) coordinate the surrounding steps. Documents must already have passed the evidence sanitizer before this boundary.

Read the helpers in this order:

1. [deduplicate.ts](deduplicate.ts) groups exact copies by content hash. For similar pages, `wordWindows()` compares five-word runs and `wordWindowSimilarity()` measures the shared fraction. Different number sets prevent a near-duplicate match. The representative is chosen by authority, then date, then URL; every source snapshot is retained.
2. [chunk.ts](chunk.ts) splits text at paragraph and section boundaries, then at sentences when needed. `trailingContext()` carries a small amount of neighboring text into the next passage. Video passages keep their timestamp and speaker labels.
3. Back in [build-index.ts](build-index.ts), exact copies share indexed passages. Near-duplicate pages keep separate passages, because a small wording change can matter to an answer. A single database transaction activates documents, passages and the corpus version together. Failure rolls it all back.

[deduplicate.test.ts](deduplicate.test.ts) checks exact copies, similar wording, changed numbers and representative choice. [chunk.test.ts](chunk.test.ts) checks stable IDs, passage size and neighboring context. [build-index.test.ts](build-index.test.ts) checks publication and recovery when a write fails. These tests need no provider calls.
