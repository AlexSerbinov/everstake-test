# Evidence: remove recognized instructions addressed to AI

Start with [sanitize-document.ts](sanitize-document.ts). `sanitizeDocument()` takes source text and returns cleaned text plus an audit of removed instructions. `sanitizeField()` applies the same filtering to a short metadata field.

The rules recognize AI-directed instructions while preserving ordinary product instructions and API commands. Sentence splitting, parenthetical handling, and short windows in long passages limit how much surrounding useful text is removed. The [crawler](../crawler/crawl-source.ts) stores the removal audit before the cleaned document reaches the [indexer](../indexer/README.md).

[sanitize-document.test.ts](sanitize-document.test.ts) checks individual rules and legitimate text. [planted-document.test.ts](planted-document.test.ts) sends poisoned examples through sanitation, indexing, and retrieval, then checks that the planted instruction text is absent before a model is involved.

This filter recognizes patterns; it cannot certify arbitrary source text as safe or true. The [answer module](../answer/README.md) separately limits research actions and checks citation IDs, dates, numbers, and support.
