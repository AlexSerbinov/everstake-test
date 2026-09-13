# Comparison with Everstake MCP

Everstake MCP at commit [`68f5f5f`](https://github.com/everstake/mcp/tree/68f5f5f02b15a666849438971a65d5923a96e5ee) exposes seven curated static read tools, three dynamic read tools for uptime, supported chains and staking calculations, and one integration-request write tool ([registration](https://github.com/everstake/mcp/blob/68f5f5f02b15a666849438971a65d5923a96e5ee/internal/server/mcp/server.go#L30-L53)). On 13 September 2026, all ten read tools were called successfully through its actual stdio server; `request_integration` was deliberately not called. MCP is the better fit for live operational values and staking calculations without maintaining a separate crawl/index, and its integration-request capability is outside this assistant's scope. This assistant adds historical, multi-publisher evidence, dated snapshots, duplicate handling and claim verification, but pays for collection, embeddings and model review and can miss or retain stale sources. The following measurement concerns this assignment's questions, not the overall usefulness of either system.

## Actual twenty-question comparison

Run `mcp-8bcd1ef1` used the same twenty question texts and frozen references as the existing evaluation. Gemini `gemini-3.8-flash`, thinking `low`, received all nine generic captured MCP read responses in a single answer turn, with a 4,000-token output limit. The calculator's separate successful probe was excluded from generic context: its scenario was unrelated to these questions. No crawled documents, reference answers or grading rubrics reached the answer model. The context was sanitized and tagged as untrusted data; citation IDs were validated in code. Factual support was independently graded afterward.

**Two independent rubric/source reviews: 7/20 passed (35%), 13 failed, 0 cases with invented facts.** The model produced three factual answers and seventeen abstentions. E03 (founding year), E04 (certifications/compliance) and all five negative cases E16–E20 passed. E02 repeated a genuine MCP claim of 130+ networks but failed to distinguish historical reach from active-network counts and conflicting dated web evidence. The remaining positive questions were unanswered because the MCP capture lacks their detailed historical or product evidence. Safe abstention is not a correct answer to an otherwise answerable positive benchmark question.

The measured generation cost was **$0.23630625 for 20 calls**, or **$0.0118153125 per question**, with 307,160 input tokens, 1,583 output tokens and no unpriced calls. This is usage-priced generation cost, not an invoice-reconciled total or a charge for MCP tool access, hosting or subscription effort.

## Limits of the comparison

This is a **single-turn captured-MCP-context benchmark**, not autonomous live MCP tool selection. MCP itself does not generate answers. The earlier agent result (19/20) and retrieval-only baseline (11/20) use the frozen web/video corpus and additional validation gates; they were not rerun during this MCP measurement. Their evidence, research actions and verification budgets differ, so the score gap does not isolate a single algorithm or prove general superiority. The twenty questions were selected for this assignment and are not a blind held-out sample.

Capture time establishes when a tool output was observed, not when every included fact became effective. A source-supported but stale or incorrectly scoped statement may fail accuracy without counting as a model-invented fact. For example, the MCP's explicit SWQOS prices are different evidence from the web corpus's missing live dashboard quote: the negative bill question passed because the response refused an unsupported all-in amount. Some MCP answers omit observation dates; the harness validates source IDs, not the full assistant's per-claim date/number gates. E15 additionally overstates the absence of regional information: the capture does mention SWQOS and NYC, although it cannot establish the requested product matrix.

## Reproduce and inspect

- [Raw MCP requests and responses](../artifacts/mcp/capture-2026-09-13.json)
- [Frozen answer context and provenance](../artifacts/mcp/evidence-2026-09-13.json)
- [All twenty original answers and receipts](../artifacts/evaluation/mcp-2026-09-13.json)
- [Independent row-by-row grading](../artifacts/mcp/grades-2026-09-13.json)
- [Measured provider ledger](../artifacts/mcp/measurements-2026-09-13.json)
- [Harness](../scripts/evaluate-mcp.ts) and [model instructions](../prompts/mcp-answer.md)

To perform a new paid run, use a new output path so the prior measurement is retained:

```sh
npx tsx scripts/evaluate-mcp.ts --evidence artifacts/mcp/evidence-2026-09-13.json --out artifacts/evaluation/mcp-new-run.json --db data/knowledge.sqlite
```

New answers require independent grading; successful API responses are not automatically passes. The redesigned interface was subsequently deployed and verified on the live host; see [hosted validation](review-logs/2026-09-13-product-pages.md).

The 7/20 result measures the frozen content rubric. Some otherwise passing responses omit an explicit observation date; this score is not a claim that every assignment answer-format requirement passed. Independent coding-agent review is not human-certified ground truth.
