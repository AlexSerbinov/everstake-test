# Corpus: inspect the saved collection

| File | What it explains |
| --- | --- |
| [corpus-page.ts](corpus-page.ts) | Browsing saved documents, their separate publication/check dates, excerpts, and collection activity. An operator can enter a token to request a refresh; the form clears it and never saves credentials. |
| [collection-summary.ts](collection-summary.ts) | The homepage summary of collection size, saved evaluation results, known API costs, and source-update status. |

The summary belongs with the collection even though `web/app.ts` displays it on the homepage. Its numbers keep their own scopes: the current corpus, a particular evaluation run, and all-time known costs do not describe the same event.
