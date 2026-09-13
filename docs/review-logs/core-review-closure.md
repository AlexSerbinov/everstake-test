# Post-fix core review closure

Reviewed against `dev` at `4b14a55` on 2026-09-13. This is a read-only closure of the original H1–H6/M1–M5 review; it does not cover the separate ingestion hardening now in progress. The coordinator reports all 84 tests passing on Linux/Node 22. The reviewer made no provider calls.

The original pre-fix score was **75** (6 high, 5 medium; higher is worse). A zero residual score would be misleading. H2 and H6 remain partially open because the final evaluation contains unsupported scope claims and unresolved conflicting-current evidence; M2 remains pending the ingestion hardening. On the original scoring scale, those residuals are **23** (2 high + 1 medium). This is a closure triage score, not an accuracy metric.

## High findings

| ID | Status | Current evidence and residual |
|---|---|---|
| **H1 — removed injection text re-entered model context** | **Addressed** | Search now exposes an explicit metadata allowlist in `src/services/search/search-corpus.ts:109-130`; raw removed sentences are absent. `src/services/search/hybrid-search.test.ts` verifies the canary is omitted. The frozen-corpus audit found zero active snapshot/chunk hits for the four known AI-instruction strings. |
| **H2 — unsupported claims passed grounding** | **Partially addressed; residual high** | `src/services/answer/verify-claims.ts:19-80` adds a metered `gemini-3.5-flash-lite` support pass and supplies all currently retrieved evidence, including uncited counterevidence. `src/services/answer/verify-claims.test.ts` proves that a universal claim is rejected when an exception is present. The control is still model-dependent: final run `agent-37174f55` scored 14/20 and emitted two unsupported universal mandatory-tip assertions (E14 and E18) despite active SWQOS counterevidence. Therefore semantic truth is improved, not solved. A minimal next control is a deterministic contradiction/scope gate for absolute terms (`every`, `always`, `mandatory`, `not optional`) when retrieved evidence contains an explicit exception; otherwise force a qualified claim or abstention. |
| **H3 — rejected final draft became abstention** | **Addressed** | `answeredAction` is set only for an explicit abstention or after all answer checks pass (`src/services/answer/answer-question.ts:185-231`); exhaustion throws and is returned as `status: error` (`:339-350`). `src/services/answer/answer-question.test.ts` covers provider errors and malformed final-action exhaustion as errors rather than corpus absence. |
| **H4 — fixed reservation could bypass cost cap** | **Addressed with stated single-call limitation** | `src/providers/model-client.ts:403-432` reserves from input bytes, configured output bound, and the requested model price; `src/services/answer/answer-question.ts:87-90,142-167` bounds evidence and output. `src/services/measurements/measurements.test.ts` verifies serialized run/session reservations and that unknown-cost attempts remain reserved. A provider returning a different priced model or unusable usage can only be accounted after that call; the next attempt is blocked, so this should be described as bounded pre-dispatch enforcement rather than an absolute bill guarantee. |
| **H5 — stale dedup representative removed searchable facts** | **Addressed** | `src/services/indexer/deduplicate.ts:70-80` clears derived duplicate state before regrouping. `src/services/indexer/deduplicate.test.ts` covers a retained document whose old representative disappeared and confirms it becomes canonical again; the same suite also keeps revised facts on one canonical URL separate. |
| **H6 — currentness/as-of/synthesis were advisory** | **Partially addressed; residual high** | Non-null evidence dates are now a deterministic gate (`src/services/answer/verify-answer.ts:23-55`), synthesis requires two duplicate groups and two dated observations (`src/services/answer/verify-claims.ts:63-78`), trust weights come from policy, and fetched dates are labelled as observations. However authority/currentness and contradictions are still adjudicated by the model rather than a final deterministic conflict rule. E02 in both agent runs failed to reconcile active 30+/35+ current statements, while E14/E18 show that the support pass can miss an active exception. The final output must retain this limitation rather than claim that currentness is fully enforced. |

## Medium findings

| ID | Status | Current evidence and residual |
|---|---|---|
| **M1 — corpus activated before embeddings succeeded** | **Addressed** | `src/workflows/staged-refresh.ts:139-175` crawls and embeds a copied database, then activates it only after embeddings succeed. `src/workflows/staged-refresh.test.ts` proves an embedding failure leaves the serving corpus/version intact and records a resumable failed job. |
| **M2 — bounded refresh treated unseen URLs ambiguously** | **Partially addressed; pending ingestion hardening** | `src/workflows/refresh-corpus.ts:61-107` removes only exact terminal 404/410 URLs, retains unseen snapshots, and marks them `refreshStatus: not_rechecked` with a freshness note. That is the correct direction for bounded and targeted refreshes. The snapshots remain active, so their exclusion from current-fact support is not a deterministic gate. Deeper refresh/identity/failure-state work belongs to the separate ingestion agent and should be closed there rather than duplicated here. Existing refresh tests cover failed targeted retention and successful replacement, not all partial-discovery cases. |
| **M3 — public diagnostics exposed user questions and answers** | **Addressed** | `src/application.ts:51-63` publishes aggregate/run receipts with `question: null`; `src/api.ts:55-67` requires `ADMIN_TOKEN` for stored answer details. `src/api.test.ts` covers operator authorization for expensive operations; the privacy behavior is clear in code but lacks a dedicated public-costs regression assertion. |
| **M4 — decompression limit applied after allocation** | **Addressed in code; direct bomb regression absent** | `src/services/crawler/fetch.ts:233-240` passes `maxOutputLength` to gzip/deflate/Brotli decompression, bounding decoded allocation. The crawler tests cover robots, private destinations, redirects, and retry behavior; no focused high-expansion compressed fixture was found. |
| **M5 — implausible future dates won recency** | **Addressed in code; direct regression absent** | `src/services/crawler/extract.ts:355-360` rejects dates later than fetch time plus one day, and both publication/update dates pass through it. The freeze migration applies the same function. Extraction tests distinguish page dates from fetch/HTTP metadata, but no explicit future-date test was found. |

## Additional bounded observations

These do not change the H1–H6/M1–M5 closure score, but they are concrete remaining hardening items:

- **Medium — request body limit is checked after full materialization.** `src/api.ts:115-117` calls `await c.req.text()` before checking 8,000 characters. A public client can make Node allocate a much larger body, and concurrent bodies reach this point before `busy` is set. Enforce a byte limit at Caddy/server streaming level and reject an oversized `Content-Length` before reading.
- **Medium — embedding shape validation accepts empty or inconsistent dimensions.** `src/providers/openai.ts:56-71` accepts an empty `data` array and vectors of differing/zero length. `src/services/search/hybrid-search.ts:80-87` then dereferences the missing query vector or silently gives dimension mismatches similarity zero. Require the expected batch count, a non-empty finite vector, and one consistent dimension at the provider boundary; add malformed-response tests.
- **Low — sanitation can remove ordinary imperative prose in mixed documents.** `src/services/evidence/sanitize-document.ts:43-64` applies `editorialDirective` to the whole document once any “information for AI assistants” marker appears. A mixed API page can therefore lose `Use POST /v1/stake...` even outside its AI-guidance section. Scope contextual removal to the identified guidance block. The current frozen corpus audit did not show loss in the known AI-guidance document.
- **Low — cached embedding count includes inactive revisions.** `src/services/search/hybrid-search.ts:54-61` counts all embeddings for the model, unlike retrieval/index selection, which joins active documents. Join active chunks/documents for the reported cache count so measured index reuse is not overstated.

## Evaluation and measured-cost cross-check

The independent grading file is `/Users/serbinov/.codex/scratchpads/everstake-execution/final-grades.json`; it contains three ordered 20-row runs and passed structural validation.

| Run | Result | Invented/unsupported facts | Measured known cost | Unknown calls | ×50 arithmetic |
|---|---:|---:|---:|---:|---:|
| `agent-2b8e50ab` | 15/20 (75%) | 1 | $0.703499290 | 0 | $35.174964500 |
| `agent-37174f55` | 14/20 (70%) | 2 | $0.758164595 | 0 | $37.908229750 |
| `baseline-895efc77` | 12/20 (60%) | 1 | $0.166603600 | 0 | $8.330180000 |

The quality iteration is an observed regression, not an improvement: it changed several execution errors into informative partial answers, but introduced an E04 false abstention and an E18 unsupported absolute. Across the final agent run, every failure is accounted for: E02 and E15 are incomplete/conflict omissions, E04 is a false abstention, E16 omits the requested availability conclusion, and E14/E18 are unsupported universal scope claims. No further unsupported factual assertions were found in the other 14 rows. Costs above are copied from the completed artifact receipts; this review made no paid calls.

## Untested limits

No provider outage/concurrency/crash injection, reverse-proxy body-limit test, decompression-bomb fixture, malformed embedding response, sanitizer fuzzing, or live-deployment/browser test was run in this closure. The reviewer did not independently reproduce the coordinator's Linux/Node 22 test run. Final corpus provenance and gold references were audited separately in `docs/evaluation-reference-audit.md`.
