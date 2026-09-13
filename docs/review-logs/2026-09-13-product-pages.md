# Product pages and measured MCP comparison review

Scope: Corpus, Costs, Evaluation, public Updates, home navigation, and a separately measured official MCP context benchmark. The Desktop design reference remains outside the project. Work continues in the registered `dev` worktree; the original checkout and other demo services are preserved.

## Review and fixes

Independent GPT-6 Astra reviews covered behavior/accounting, public API boundaries, responsive layout, and MCP methodology. Confirmed findings were fixed before deployment:

- A full update requested during a partial pass now adds missing enabled sources without restarting completed jobs.
- Viewing a pass that was active at the last poll is read-only, preventing a stale button from starting another paid pass.
- Retry controls refresh when source enablement changes, even when job history is unchanged.
- Incomplete evaluation status wraps without overlapping score statistics.
- The public cost dashboard keeps root and child visitor question text private, preserving the previous API boundary. Costs remain searchable by operation/type/ID.

No confirmed P0–P2 findings remain after fixes and focused regression checks. The public update control is an explicitly requested demo behavior. JSON and same-origin browser guards remain; protected internal refresh/run APIs still require authentication.

## Validation

- TypeScript and 175 serialized unit/integration tests passed before the final privacy correction; the affected cost tests and typecheck passed again afterward.
- Browser checks at 1440px, 1024px, 390px and 320px: Corpus pagination/search/empty state, Costs charts/filter/receipt, Evaluation groups/incomplete state and comparison, Updates progress/reload/retry/settings, and logo reset after an answer. No horizontal overflow or browser errors observed.
- Update lifecycle tests use isolated fixtures: three sources, two successes, one failure; retry only the failed source. No fixture outcomes are published as live updates.
- Actual official MCP capture: pinned commit `68f5f5f02b15a666849438971a65d5923a96e5ee`, ten successful read-only tool calls, no write tool invocation. Twenty real Gemini requests cost $0.23630625 with no unknown call costs. Two independent rubric/source audits agree on 7/20, zero invented-fact cases.
- The comparison explicitly distinguishes a captured MCP-context benchmark from autonomous tool use and discloses the historical corpus bias. Observation dates are not effective dates; rubric accuracy is not universal compliance with every answer-format requirement.
- The measurement importer is idempotent and rolls back on conflicting existing IDs, preserving serving-ledger costs.

Hosted validation is recorded separately after publication. The full paid all-source refresh is not represented by the offline fixture.

## Follow-up product refinement

The owner requested spreadsheet-density rows and explicit provider prices after viewing an older open browser tab. Corpus now has six single-line columns and 44px rows; narrow screens scroll inside the table. Costs leads with observed query/update-run averages and separate Soniox/Gemini/OpenAI model totals. Three additional cost tests cover provider partitioning and update-run sampling. Independent review found no new P0–P2 issues. The public cost API still excludes raw visitor questions.

Publication detected a shared-host build race: a separate frontend change entered the mutable Docker build directory. Rebuilt from a Git archive and verified the exact image digest, then corrected `scripts/deploy.sh` to use the same immutable flow. The failed mixed build is not treated as final UI validation.

Latest local verification: typecheck and all 177 tests passed after the dense-table/provider-cost refinement. Browser recheck at 1440px and 390px confirmed 100 rows at 44px, contained horizontal table scrolling, model/provider cards, and explicit empty-average states.

A real token-free source update completed on the host: job `567e73ad-4775-46d8-afee-13483ab01fc7`, Blockspace website, 34.1 seconds, three unchanged documents, 938 retained, no provider calls or charges, activated `corpus-231c8c9b17fd`. Earlier security and company-site refreshes failed incomplete collection and retained the old corpus; those failures remain visible. This is not a claim of a successful all-source/full-YouTube refresh.
