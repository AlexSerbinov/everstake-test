# Collection workflows

Coordinates crawling, document preparation, and index activation for initial collection and source refreshes. The workflows reuse the feature modules rather than creating a second ingestion implementation.

A staged refresh prepares and embeds replacement evidence before activating it. Failed preparation keeps the previous corpus available; embedding calls can incur API costs. Start with `build-corpus.ts` for initial collection and `staged-refresh.ts` for staged updates.
