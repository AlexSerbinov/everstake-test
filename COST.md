# Measured API costs

Scope: this TypeScript rebuild, from provider probes through collection, indexing, YouTube, diagnostic questions and final evaluations. Prior Claude/Codex totals are historical and are not added to these runs. Subscription agent effort, existing server rental and bandwidth are not provider-token charges.

**Known usage-priced / provider-reported total: $4.462078; 7 calls have unknown actual cost.** This is not an invoice-reconciled grand total. Unknown values stay null in the ledger and UI; forecasts/reservations are shown separately. [Full measured ledger](Costs/measured-ledger.json).

| Operation | Calls | Input tokens | Output tokens | Known cost | Unknown cost calls |
|---|---:|---:|---:|---:|---:|
| provider-probe | 2 | 28 | 206 | $0.000793 | 0 |
| youtube-transcription | 18 | 350513 | 229237 | $1.328459 | 0 |
| youtube-speaker-review | 30 | 325901 | 112382 | $0.672300 | 0 |
| index | 130 | 2166597 | 0 | $0.043332 | 5 |
| query-embedding | 170 | 4102 | 0 | $0.000082 | 0 |
| answer | 214 | 1816734 | 163569 | $1.977369 | 1 |
| claim-verification | 60 | 459761 | 12916 | $0.170218 | 0 |
| baseline | 32 | 124901 | 40952 | $0.247246 | 1 |
| currentness-review | 7 | 9398 | 2299 | $0.015670 | 0 |
| scope-review | 1 | 1338 | 1495 | $0.006610 | 0 |

Each attempt is written before the external request. Successful, retried, timed-out and invalid-content calls retain their usage. Soniox costs are reconciled against matching provider usage logs when available; its input token count includes audio and text, with the separate counts retained in the YouTube ledger. For model calls, native provider usage supplies tokens; a dated price table in `config/models.yaml` converts usage to cost. Cached-input and thinking tokens are handled without counting them twice. Parent receipts aggregate descendant calls once. HTTP failures without usage remain unknown rather than being silently priced at zero, and so do attempts cancelled by a stopped request: the provider may still bill the interrupted call.

## Index and one query

Building and repairing the index consumed **2,166,597 measured input tokens**, costing **$0.043332 known**, with 5 unpriced failed attempts. This includes the initial web build and changed/new transcript chunks; cached embeddings were reused on resume. The final corpus has 941 documents. The temporary embedding rate limit and the resumed run remain visible.

- agent run `agent-2b8e50ab`: $0.703499 known / 20 = **$0.035175 per query on average**; 0 unknown calls. Median latency 20.2s; p95 33.5s.
- agent run `agent-37174f55`: $0.758165 known / 20 = **$0.037908 per query on average**; 0 unknown calls. Median latency 20.1s; p95 30.6s.
- baseline run `baseline-895efc77`: $0.166604 known / 20 = **$0.008330 per query on average**; 0 unknown calls. Median latency 6.0s; p95 17.2s.
- agent run `agent-b0993aac`: $0.686453 known / 20 = **$0.034323 per query on average**; 0 unknown calls. Median latency 13.1s; p95 41.9s.
- baseline run `baseline-5c467370`: $0.186207 known / 20 = **$0.009310 per query on average**; 0 unknown calls. Median latency 5.8s; p95 13.4s.
- agent run `agent-9a157413`: $0.842412 known / 20 = **$0.042121 per query on average**; 0 unknown calls. Median latency 20.2s; p95 45.6s.
- baseline run `baseline-c656c369`: $0.243542 known / 20 = **$0.012177 per query on average**; 0 unknown calls. Median latency 8.5s; p95 19.0s.

## 50× extrapolation — assumptions, not measured production results

At the same average document/chunk length and embedding price, 941 × 50 = **47050 documents**. Measured build tokens 2166597 × 50 = **108329850 tokens**. Known embedding cost $0.043332 × 50 = **$2.166597**, excluding unresolved charges. This scales the observed build, including its reprocessing overhead; a clean first build can differ.

Query model context and tool steps remain capped, so LLM input cost is not assumed to grow 50× merely because the corpus does. It must be remeasured: harder retrieval may need more calls. The current exact vector scan and JSON vectors will grow substantially in CPU, RAM and latency; an approximate vector index and incremental scheduling would be the first scale changes. No claim is made that this demo sustains 50× data at the same latency.

## YouTube

18 videos totaling 42,038 seconds (11.677 hours) were submitted for transcription. Gemini has 30 measured speaker-review attempts, known cost $0.672300. 0 transcription charges remain unknown. Soniox provider-reported known cost is **$1.328459**; matching uses the recorded operation and transcription IDs. The recorded transcription forecast totals **$1.167722**, using duration / 3,600 × the configured $0.10/hour assumption, not a measured invoice. 6 transcripts are active in the corpus; only eligible attributed testimony is active; uncertain attributions and recordings without qualifying testimony remain outside the index. The full inventory and outstanding work are in [Costs/YouTube](Costs/YouTube/README.md).

Reserving a conservative amount before a call limits further work; it is not a guarantee of an external provider's final bill. Public demo calls have a per-run limit and a process-session ceiling. Restarting the process starts a new session budget.
