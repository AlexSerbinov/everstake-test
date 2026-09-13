# YouTube speaker/evidence review

Scope: named speaker attribution, dialogue exclusion, readable exports and indexing. Minimal general review selected initially under 77% weekly usage; user explicitly authorized an extra independent attribution-output reviewer.

## General review — iteration 1

Readiness 76/100. Reviewer findings:
1. HIGH: main process/rebuild reads legacy review.json rather than new review-v2.json; old reviews can omit evidence exclusion decisions.
2. MEDIUM: subset review replaces manifest/index/documents and drops other reviewed entries.
3. LOW: design document describes implemented speaker review as future work.

Fixes: process/rebuild now use v2 envelopes and input hashes; old reviews without scope classification cannot emit evidence. Subset runs retain entries outside their selected IDs. Design status distinguishes implemented review/evidence indexing from proposed topic notes. Alternatives rejected: copying v2 reviews over legacy files loses provenance; permitting old reviews bypasses scope review.

Checks and independent output review will be appended after batch completion.

## Operational recheck

Readiness 88/100 before final fixes: stale v2 caches skipped review cost forecasting; build-before-embed could activate incomplete vectors. Fixed hash-based forecasting and staged activation. New tests cover failed embedding retention, non-YouTube retention, repeated activation with no paid embeddings, and combined corpus version changes. Independent focused reviewer reported 97/100 after fixes, no concrete remaining defect.

## Actual-output QA

The second reviewer inspected completed Gemini results and Soniox turns. Six 5,000-token responses were truncated because thinking consumed the output budget; 16,000-token retries completed. Eight editorial corrections are recorded in `docs/youtube/ATTRIBUTION_QA.md`. Original dialogue is unchanged; cache edits include explicit editorial provenance. Unknown speakers and role conflicts remain unpromoted.
