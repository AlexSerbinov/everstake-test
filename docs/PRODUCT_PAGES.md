# Product pages release notes

The mint/forest design is shared across all pages. Corpus now displays 100 documents in compact 44px table rows with separate source/type/date columns with collection-wide search, type/copy filters and expandable excerpts. Costs leads with measured query/update-run averages and individual Soniox, Gemini and OpenAI cards. Each provider exposes its models and known charges. Detailed purpose/model/stage/day breakdowns and a 50× index forecast remain expandable. A source update run is not the same unit as a complete multi-source UI pass. Its public ledger does not disclose visitor prompts.

Evaluation separates pass rate from grading progress and groups simple, hard and negative cases. The latest matching saved twenty-question runs can be compared across the knowledge assistant, retrieval baseline and official MCP with Gemini; individual responses and grading explanations remain inspectable. Read [MCP comparison](MCP_COMPARISON.md) before interpreting the percentages. Clicking the header brand resets the answer view and returns to the main question form.

Updates provides a prominent full-pass action without entering an operator token, durable source progress and explicit per-source retries. Advanced schedule settings are collapsed initially. The pass respects saved enablement, source bounds and existing API budgets; success means the source job completed, not that every possible page or video was found. See [Updates](UPDATES.md).

## Publication

Build and test the committed tree. Preserve the host's `.env` and persistent `data/`; do not replace its corpus with the local evaluation snapshot. Import `artifacts/evaluation/` with `npx tsx scripts/import-evaluations.ts`, then import the measured MCP ledger once using `npx tsx scripts/import-mcp-measurements.ts artifacts/mcp/measurements-2026-09-13.json`. The second importer validates idempotence and refuses conflicting measurements. Neither import executes model calls. Restart only the independent `knowledge` Compose service with its actual commit ID, and verify HTTP health plus the browser routes.

Use `scripts/deploy.sh` to build an immutable Docker context directly from the committed Git archive and select the exact commit-tagged image. A shared mutable server checkout must never be the build context: parallel publication can otherwise mix an old frontend with a new backend. Static assets revalidate on page reload.
