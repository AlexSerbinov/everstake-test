# YouTube cost ledger

`ledger.json` is exported from the shared runtime database. Each external attempt is recorded before submission. Gemini costs use provider-reported tokens and the dated price table. Soniox costs are reconciled from its usage-log API, matching both our operation ID and the provider transcription ID. Native audio/text token breakdowns remain in row metadata. Forecasts remain separate.

## Initial transcription work — 2026-09-13

| Batch | Videos | Audio seconds | Actual Soniox USD |
|---|---:|---:|---:|
| Initial pilot and follow-up | 6 | 9,868 | $0.291013 |
| Selected interviews and panels | 12 | 32,170 | $1.037446 |
| Total | 18 | 42,038 | $1.328459 |

The six earlier Gemini speaker reviews cost $0.067074 (51,992 input and 7,488 output tokens). Total measured YouTube processing cost is **$1.395533**, with no unknown charges among these 24 calls. No Gemini call was made for the new 12-video batch. Its duration forecast was $0.893611; actual token-based billing was $1.037446. See [per-video costs](batch-2026-09-13.md) and [machine-readable detail](batch-2026-09-13.json).

Four reviewed video documents are active in the corpus. Two earlier reviews remain quarantined for invalid or unsupported attribution. The 12 new timed transcripts are saved but await speaker/content review; they are not active answer sources. Anonymous speaker labels are not verified names or roles. No paid review was retried.

## Discovery and reuse

The inventory contains 186 distinct videos from the legacy manifest and official channel. Inventory acceptance means a candidate is relevant for processing, not that its transcript is verified. Current screening counts are in `inventory-summary.json`; the selected batch is in `artifacts/youtube/selected-batch-2026-09-13.json`. Future updates reuse completed jobs and their cached provider responses by video ID/audio hash rather than submitting again.

Readable transcripts are in `artifacts/youtube/transcripts/`; raw responses and job state remain under `data/youtube/`. [Topic-aware retrieval design](../../docs/YOUTUBE_KNOWLEDGE.md) explains the proposed next stage. Navigation notes will be search aids linked to original dialogue, not independent evidence.

[Soniox usage logs](https://soniox.com/docs/guides/usage-logs) provide the actual per-request amounts. The approximate hourly [pricing](https://soniox.com/pricing) is used only for planning.

## Named-speaker review update

[Gemini 3.8 Flash review of all 18 transcripts](speaker-review-2026-09-13.md) added $0.605226 across 24 calls, including six paid failed-output attempts followed by successful retries. Cumulative transcription/review total: **$2.000759**, with no unknown YouTube charges. The earlier pilot figures above are historical. Six recordings now have eligible attributed testimony; all eighteen have readable review exports. Ten need further review and two reviewed recordings lack eligible named company testimony. Activation embeddings are metered separately as the `index` stage of a `youtube_index` run.

The live activation embedded 189 passages (32,425 input tokens, **$0.0006485**). Repeating activation reused all 189 vectors and made zero embedding calls. The separate live interview question cost **$0.06448759** and returned a cited answer with the recording upload date and a `t=252` YouTube link. These amounts are in the global measured ledger, not added twice to the transcription/review total.
