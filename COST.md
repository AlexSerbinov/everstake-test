# Measured API costs

The Costs section is better presented on the website: I focused primarily on that section. [Open the Costs page](https://everstate-knowledge-base.89-167-19-222.sslip.io/#costs).

> **УКРАЇНСЬКА ВЕРСІЯ: [COST](submission_ukr/COST.md) · [УСЯ УКРАЇНСЬКА ДОКУМЕНТАЦІЯ](submission_ukr/README.md)**

[Українська версія](submission_ukr/COST.md) · [Live Costs page](https://everstate-knowledge-base.89-167-19-222.sslip.io/#costs)

These are saved measurements of the TypeScript implementation, not a quote for a future deployment or a reconciled invoice. The live ledger can contain later activity. Earlier Claude/Codex prototype costs, coding-agent subscriptions, human effort, server rental and bandwidth are outside this API ledger; they are not assumed to cost zero.

## Required measurements (§5.6)

| Measurement | Recorded result | Exact scope |
|---|---:|---|
| Index input tokens | **2,166,597** | 130 embedding attempts, including build/repair and transcript additions; five attempts have unknown cost |
| Index cost | **$0.04333194 known** | Historical ledger snapshot; includes reprocessing, not a clean-build benchmark |
| One agent query, mean | **$0.052058** | Core-v2 full run `agent-cdf52dda`: $1.04116947 / 20 questions |
| MCP-context query, mean | **$0.011848** | Core-v2 `mcp-core-v2`: $0.236955 / 20 questions; generation only |
| Historical ledger total | **$4.46207828 known; 7 unknown calls** | Exported 2026-09-13 17:23:15.976 UTC, 664 calls, corpus `corpus-1a0f3db1d4fd` |

The last row is **a dated snapshot, not all spending through the final code version**. The later core-v2 runs below are separate records. Do not add every saved evaluation subtotal to the ledger: some earlier calls are already included. No deduplicated all-time total covering later activity has been produced for this document.

A later [hosted check](artifacts/demo/product-pages/verification.json), 2026-09-13 19:08:34.168 UTC, records **$5.175148275 known and eight unpriced calls**, with 941 documents in corpus `corpus-231c8c9b17fd`. This is another accounting snapshot, not an addition to $4.46207828, and not a full per-call export for reconstructing all later spending.

## Where to verify the numbers

[Historical ledger](artifacts/costs/measured-ledger.json) contains `generatedAt`, `corpusVersion`, `overview`, `runs` and individual `calls`. Sum `calls[].cost_usd` once per unique call ID; keep null costs separate. For the index, filter `calls[].stage == "index"` and sum `input_tokens` and known `cost_usd`. Do not add parent receipts to their child calls.

For a saved evaluation, open `summary.knownCostUsd`, `summary.unknownCalls` and `summary.total`; individual `rows[].answer.receipt` records provide the audit trail. Dividing by all twenty planned questions includes failed answers, which also incur costs. It does not divide only by successful answers. See [EVAL.md](EVAL.md) for verdicts and assessment limitations.

| Saved run | Questions | Known USD | Mean USD/question | Unknown calls |
|---|---:|---:|---:|---:|
| [Core-v2 full agent run](artifacts/evaluation/agent-cdf52dda.json) | 20 | 1.04116947 | 0.0520584735 | 0 |
| [Two subsequent rechecks](artifacts/evaluation/agent-82df0052.json) | 2 | 0.10677069 | 0.053385345 | 0 |
| [Seven additional scenarios](artifacts/evaluation/agent-ef0d0de2.json) | 7 | 0.27800609 | 0.039715156 | 0 |
| [Core-v2 MCP-context comparator](artifacts/evaluation/mcp-core-v2.json) | 20 | 0.236955 | 0.01184775 | 0 |
| [Earlier agent run](artifacts/evaluation/agent-9a157413.json) | 20 | 0.84241179 | 0.0421205895 | 0 |
| [Earlier simple-RAG baseline](artifacts/evaluation/baseline-c656c369.json) | 20 | 0.24354193 | 0.0121770965 | 0 |

Core-v2 agent runs used corpus `corpus-664b2e73d71f`; the earlier agent/simple-RAG pair used `corpus-eae2b2b23116`. The earlier baseline is not a controlled core-v2 comparison. Full core-v2 plus two rechecks cost **$1.04116947 + $0.10677069 = $1.14794016 for 22 attempts**. The current 16/20 summary retains eighteen answers and replaces two; it is not a fresh twenty-question run. External coding-assistant grading was not separately API-metered here.

Other historical runs, partial runs and their original costs remain in [evaluation artifacts](artifacts/evaluation/README.md); they are not erased when a later answer succeeds.

## Historical ledger breakdown

| Operation | Calls | Input tokens | Output tokens | Known USD (rounded) | Unknown calls |
|---|---:|---:|---:|---:|---:|
| provider-probe | 2 | 28 | 206 | 0.000793 | 0 |
| youtube-transcription | 18 | 350,513 | 229,237 | 1.328459 | 0 |
| youtube-speaker-review | 30 | 325,901 | 112,382 | 0.672300 | 0 |
| index | 130 | 2,166,597 | 0 | 0.043332 | 5 |
| query-embedding | 170 | 4,102 | 0 | 0.000082 | 0 |
| answer | 214 | 1,816,734 | 163,569 | 1.977369 | 1 |
| claim-verification | 60 | 459,761 | 12,916 | 0.170218 | 0 |
| baseline | 32 | 124,901 | 40,952 | 0.247246 | 1 |
| currentness-review | 7 | 9,398 | 2,299 | 0.015670 | 0 |
| scope-review | 1 | 1,338 | 1,495 | 0.006610 | 0 |

## Accounting method

The [provider wrapper](src/providers/model-client.ts) records an attempt before making the request. Retries, invalid model content, failures and cancellations remain visible. Native provider usage supplies token counts; the dated [model price configuration](assistant/config/models.yaml) converts usage to USD, and each call retains its price snapshot. Cached-input and thinking tokens must not be counted twice. Changing today's prices does not reprice historical records.

A missing usage response is **unknown**, even if an interrupted request may have been billed. The [receipt aggregator](src/services/measurements/receipt.ts) includes descendant calls once. A reservation limits further work but is a forecast, not a provider charge or a guarantee of the final bill. Demo budgets have per-run and process-session limits; restart begins a new session budget.

## 50× extrapolation — a forecast

Use the historical index measurement and its **941-document** corpus scope. This is distinct from later evaluation snapshots. Preserve unrounded arithmetic:

| Item | Calculation | Forecast |
|---|---|---:|
| Documents | 941 × 50 | 47,050 |
| Index input tokens | 2,166,597 × 50 | 108,329,850 |
| Known index cost | 2,166,597 / 1,000,000 × $0.02 × 50 | **$2.166597** |
| Mean query cost | $1.04116947 / 20 × 1 | **$0.0520584735** |

Index assumptions: unchanged average chunk length, reprocessing overhead and embedding tariff; unresolved charges excluded. Query context and tool turns are capped, so corpus size alone does not imply 50× generation spend. Carrying the measured query average over is a planning assumption, not a measured scale result: retrieval difficulty, retries and review calls can change it. Exact vector scanning and JSON vectors will increase CPU, RAM and latency; an approximate vector index and incremental scheduling would be early changes. No unchanged-latency claim is made.

## Video and MCP boundaries

The historical video batch submitted **18 videos, 42,038 seconds (11.677 hours)**. Soniox usage logs establish **$1.328459**; all eighteen transcription costs are known. Thirty Gemini speaker-review attempts cost **$0.672300**. Duration-based transcription forecast **42,038 / 3,600 × $0.10 = $1.167722** is separate from the provider-reported charge. Six transcripts were active in the ledger's corpus; uncertain attribution or no qualifying testimony kept other recordings outside the index. [Video inventory and receipts](artifacts/costs/YouTube/README.md).

The earlier [MCP measurement](artifacts/mcp/measurements-2026-09-13.json), run `mcp-8bcd1ef1`, recorded 307,160 input and 1,583 output tokens across twenty calls: **$0.23630625**, zero unknown calls, mean **$0.0118153125**. Core-v2's separate measurement is **$0.236955**. These measure answer generation with captured MCP context, excluding MCP hosting and unmeasured service-access charges. Missing service-cost measurements do not mean free operation. See the [comparison method](docs/MCP_COMPARISON.md).
