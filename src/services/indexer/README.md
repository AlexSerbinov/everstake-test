# Build the searchable index

Turns extracted documents into source-linked passages and a searchable SQLite corpus. Deduplication groups related publications: exact copies share indexed text, while near-duplicate variants retain their own passages so changed facts are not lost.

Start with `build-index.ts`. Index activation is transactional, so a failed rebuild leaves the previous corpus active. The [collection workflows](../../workflows/README.md) coordinate the surrounding steps.
