# Measured API costs

Scope: this TypeScript rebuild, from provider probes through collection, indexing, YouTube, diagnostic questions and final evaluations. Prior Claude/Codex totals are historical and are not added to these runs. Subscription agent effort, existing server rental and bandwidth are not provider-token charges.

**Known usage-priced total: $4.616122; 22 calls have unknown actual cost.** This is not an invoice-reconciled grand total. Unknown values stay null in the ledger and UI; forecasts/reservations are shown separately. [Full measured ledger](Costs/measured-ledger.json).

| Operation | Calls | Input tokens | Output tokens | Known cost | Unknown cost calls |
|---|---:|---:|---:|---:|---:|
| provider-probe | 2 | 28 | 206 | $0.000793 | 0 |
| youtube-transcription | 6 | 0 | 0 | $0.000000 | 6 |
| youtube-speaker-review | 6 | 51992 | 7488 | $0.067074 | 0 |
| index | 127 | 2134172 | 0 | $0.042683 | 5 |
| query-embedding | 564 | 17246 | 0 | $0.000345 | 6 |
| answer | 359 | 3018938 | 274831 | $3.301966 | 4 |
| claim-verification | 132 | 1402984 | 27340 | $0.489245 | 0 |
| baseline | 72 | 281021 | 91751 | $0.554832 | 1 |
| currentness-review | 34 | 43090 | 9551 | $0.068134 | 0 |
| scope-review | 31 | 46124 | 15055 | $0.091049 | 0 |

Each attempt is written before the external request. Successful, retried, timed-out and invalid-content calls retain their usage. Native provider usage supplies tokens; a dated price table in `config/models.yaml` converts usage to cost. Cached-input and thinking tokens are handled without counting them twice. Parent receipts aggregate descendant calls once. HTTP failures without usage remain unknown rather than being silently priced at zero, and so do attempts cancelled by a stopped request: the provider may still bill the interrupted call.

## Index and one query

Building and repairing the index consumed **2,134,172 measured input tokens**, costing **$0.042683 known**, with 5 unpriced failed attempts. This includes the initial web build and changed/new transcript chunks; cached embeddings were reused on resume. The final corpus has 939 documents. The temporary embedding rate limit and the resumed run remain visible.

- agent run `agent-2b8e50ab`: $0.703499 known / 20 = **$0.035175 per query on average**; 0 unknown calls. Median latency 20.2s; p95 33.5s.
- agent run `agent-37174f55`: $0.758165 known / 20 = **$0.037908 per query on average**; 0 unknown calls. Median latency 20.1s; p95 30.6s.
- baseline run `baseline-895efc77`: $0.166604 known / 20 = **$0.008330 per query on average**; 0 unknown calls. Median latency 6.0s; p95 17.2s.
- agent run `agent-b0993aac`: $0.686453 known / 20 = **$0.034323 per query on average**; 0 unknown calls. Median latency 13.1s; p95 41.9s.
- baseline run `baseline-5c467370`: $0.186207 known / 20 = **$0.009310 per query on average**; 0 unknown calls. Median latency 5.8s; p95 13.4s.
- agent run `agent-9a157413`: $0.842412 known / 20 = **$0.042121 per query on average**; 0 unknown calls. Median latency 20.2s; p95 45.6s.
- baseline run `baseline-c656c369`: $0.243542 known / 20 = **$0.012177 per query on average**; 0 unknown calls. Median latency 8.5s; p95 19.0s.

## 50× extrapolation — assumptions, not measured production results

At the same average document/chunk length and embedding price, 939 × 50 = **46950 documents**. Measured build tokens 2134172 × 50 = **106708600 tokens**. Known embedding cost $0.042683 × 50 = **$2.134172**, excluding unresolved charges. This scales the observed build, including its reprocessing overhead; a clean first build can differ.

Query model context and tool steps remain capped, so LLM input cost is not assumed to grow 50× merely because the corpus does. It must be remeasured: harder retrieval may need more calls. The current exact vector scan and JSON vectors will grow substantially in CPU, RAM and latency; an approximate vector index and incremental scheduling would be the first scale changes. No claim is made that this demo sustains 50× data at the same latency.

## YouTube

6 videos totaling 9,868 seconds (2.741 hours) were submitted for transcription. Gemini has 6 measured speaker-review attempts, known cost $0.067074. 6 transcription charges remain unknown. The recorded transcription forecast totals **$0.274111**, using duration / 3,600 × the configured $0.10/hour assumption, not a measured invoice. 4 transcripts are active in the corpus; uncertain attributions remain quarantined. The full inventory and outstanding work are in [Costs/YouTube](Costs/YouTube/README.md).

Reserving a conservative amount before a call limits further work; it is not a guarantee of an external provider's final bill. Public demo calls have a per-run limit and a process-session ceiling. Restarting the process starts a new session budget.
