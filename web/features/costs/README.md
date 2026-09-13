# Costs

`cost-overview.ts` reads the enriched `/api/costs` ledger dashboard without model calls. It shows measured totals, completed fully priced query mean/range, index tokens, purpose/model/stage breakdowns, the last 14 recorded UTC dates, and an explicitly hypothetical 50× index-cost extrapolation. Query embeddings are excluded from the index forecast. Accumulated rebuilds and retries remain included, so the forecast is not presented as a clean single-build benchmark.

The compact operation ledger supports operation/ID search, activity and cost-state filters, and lazy expansion of receipts. Only root operations appear in subtotals; their child calls are included once. Raw visitor questions stay private and are not returned by the public cost API. Pending calls, finished unpriced calls and failures are shown distinctly. Known usage costs are not provider invoice reconciliation; missing charges, hosting and subscriptions are not invented.

`cost-receipt.ts` remains the shared receipt component. `public/costs.css` scopes the dashboard's mint/forest visual layout and responsive ledger. Backend enrichment lives in `src/services/measurements/cost-dashboard.ts`.
