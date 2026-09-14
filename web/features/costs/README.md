# Costs: show recorded spending and each operation’s receipt

Start with [cost-overview.ts](cost-overview.ts) for the page, then [cost-receipt.ts](cost-receipt.ts) for one operation. [receipt-attempts.ts](receipt-attempts.ts) renders individual provider attempts loaded by the receipt component; [activity-label.ts](activity-label.ts) gives recorded operations readable labels.

`cost-overview.ts` opens with the measured mean cost of one question and one refresh run, total recorded spending and unpriced-call counts. These are observed averages, not fixed prices: failed, running and unpriced runs are excluded from the samples, while their known charges remain in total spending. A refresh root can cover one or several sources, and a full Updates pass may contain many roots. Both website and incremental YouTube updates use the `refresh` run kind; standalone video processing is not counted as an update.

Compact provider panels show Soniox transcription, Gemini answer/extraction/review and OpenAI embedding totals with the actual models from the ledger. Missing activity is labeled explicitly. Other providers remain accounted for. Pending attempts, finished unpriced attempts and failed/cancelled attempts stay distinct; status counts can overlap with pricing states. Costs are usage-priced or recorded service charges, not invoice reconciliation or estimates of hosting and subscriptions.

The operation ledger supports ID/activity search, filters and expandable receipts. Public prompt text stays redacted. Root subtotals include child calls once. Detailed purpose/model/stage charts, the last 14 recorded UTC dates and the explicitly hypothetical 50× index scenario are below the ledger in a collapsed disclosure. Query embeddings are excluded from the index forecast; accumulated rebuilds and retries remain included.

Backend aggregation and its in-memory ledger regression tests live in [cost-dashboard.ts](../../../src/services/measurements/cost-dashboard.ts) and the adjacent test file. [costs.css](../../../public/costs.css) scopes the responsive mint/forest design. `cost-receipt.ts` remains the shared receipt component.
