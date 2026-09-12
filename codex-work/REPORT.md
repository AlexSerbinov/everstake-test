# Technical and Product Report

## Architecture: an evidence agent, not a retrieval wrapper

The answer path is now **question guard → model-selected tool loop → deterministic verification → signed audit record → streamed answer**. Gemini 3.8 Flash (`gemini-3.8-flash`) receives the production prompt from `prompts/agent-system.txt` and native function declarations from `agents/tools.json`; these are loaded at runtime, not copied into a hidden constant. The adapter replays Gemini 3 thought signatures with model content, uses supported low thinking, and omits thinking configuration entirely for Gemini 3.5 Flash Lite. The model can take at most five evidence turns. A sixth function-constrained turn is reserved for `submit_answer`, so prose cannot bypass validation and repeated live calls cannot run indefinitely.

The retrieval base remains deliberately inspectable: 304 documents, 294 duplicate groups, 1,223 sanitized chunks, SQLite FTS5, 512-dimensional `text-embedding-3-small` vectors, speaker-aware authority, date policy, and explicit contracts for mutable corporate facts. The model decides what evidence operation is needed; application code decides what tools are allowed and whether the submitted citations are valid.

## Sources and trust

YouTube discovery searched seven Everstake queries and inspected 31 candidates. It accepted **24 new videos** with usable free `en-orig`/English auto-subtitles and minute markers: **9 official-channel**, **6 employee-on-third-party**, and **9 third-party**. Seven were rejected: two look-alikes, two clips under 60 seconds, and three without usable subtitles. Together with three existing video rows, the corpus now contains 27 videos.

`config/people.yaml` carries seven maintainable names, aliases, roles, and date ranges; `people:sync` proposed no additions from the current About snapshot. Classification is deterministic across metadata, registry names, and transcript self-introductions. Ranking multiplies ordinary authority and recency by configurable voice authority (0.7 official, 0.6 employee elsewhere, 0.4 third party) and any document penalty.

The code-only fact pass extracted **2,924 attributed numeric facts**, flagged **38 key/period contradictions**, applied a 0.5 penalty to **14 documents** with at least two verified-key conflicts, and marked **23 reported facts unverified** because no same-period first-party value existed. `stated` evidence orders before `reported`; third-party material cannot override it. Numeric answers grounded only in reporting must contain `according to X (date)`, and unverified evidence is unavailable unless the question explicitly asks about claims, rumours, or opinions. Negative third-party-only claims must be framed as a named claim and marked unverified or validation abstains.

## Tools and stopping rules

| Tool | Use | Server-enforced boundary |
|---|---|---|
| `corpus_search` | Durable facts and multi-document history | Canonical duplicate only; authority/date ranking; temporal diversity for synthesis |
| `fact_number_lookup` | Exact amounts, dates, rates, legal names, addresses | Returns literal numeric passages; no calculation or discounting |
| `document_read` | More context from one search result | Canonical indexed document ID only; bounded text |
| `live_fetch` | A specific page when the snapshot may be stale | HTTPS, exact Everstake host allowlist, robots check, redirect revalidation, 3 MB cap, instruction sanitation |
| `everstake_mcp` | Live chain APR/APY, fee, status, uptime, calculator | Only six read-only tools; `request_integration` and every mutation are unreachable |
| `submit_answer` | Stop and request validation | Citation refs must exist; supported answers need citations; synthesis needs distinct URLs and real date coverage |

The policy prefers the frozen corpus for stable facts and history, MCP for operational metrics, and live page fetch only when a known canonical URL may have changed. For APY, `get_chains` identifies the ticker and the calculator is called with one unit as a neutral rate probe; illustrative rewards are discarded. APR and APY may never be relabelled. A successful calculator or uptime result is terminal evidence, preventing redundant calls. A synthesis search with two distinct dated sources is terminal too, avoiding repetitive searches. Missing, private, contradictory, unsupported, tool-failed, or policy-override questions resolve to the exact abstention: `No reliable answer was found in the corpus.`

## Visible pipeline

`POST /api/query/stream` emits server-sent events for `thinking`, `tool_call`, `tool_result`, `verification`, `answer`, and `error`. Tool arguments are visible; result events expose titles, dates, provenance type, and SHA-256 rather than dumping sensitive internals. The UI progressively renders those events, then shows sources and the audit receipt. A dedicated Cost view turns the same measurements into headline totals, money/time bars, and expandable stage runs; every answer has a receipt with each model, embedding, and code step. Dark/light themes, mobile layout, reduced-motion support, loading, supported, abstained, and error states are implemented without a front-end framework. Browser captures are in `screenshots/`.

The complete accounting method and reproducible ×50 arithmetic are generated in `COST.md` by `make cost`. Provider token counts come directly from OpenAI `usage` and Gemini `usageMetadata`; prices are a dated configuration table. Every stage also records wall-clock time, process CPU, peak RSS, units, and downloaded bytes, including $0 code-only stages. Historical paid-call rows are aggregated only for fields they actually contain; missing historical CPU/RAM/time remains explicitly unknown. Hardware transfer and serial ×50 timing are labelled assumptions, not forecasts.

## Freshness: policy by source type, priced before selection

Question-time freshness and background freshness solve different problems, so the implementation uses both. The scheduler runs hourly but each of seven source classes has its own interval and depth. The shipped **Balanced** policy uses daily/full-on-change for 15 live pages; daily/changed-document extraction for 188 blog pages and one docs root; weekly changed-document extraction for 57 reports/events; GitHub organisation checks every six hours; and weekly cheap checks for three videos and 12 third-party pages. A source can instead be hourly, six-hourly, daily, weekly, monthly, or never, with cheap detection, changed-document re-extraction, or a full re-index.

- Dynamic values (APY/APR, chain state, uptime, estimates) come from Everstake MCP during the question. This adds roughly one or two network/model turns but avoids presenting a week-old rate as current.
- An hourly systemd timer runs `app.refresh`, which executes only policies currently due. Web sources stop at the first proof of no change: sitemap `lastmod`, then conditional GET with ETag/Last-Modified, then normalized extracted-content SHA-256. New sitemap URLs are discovered. GitHub uses `GET /orgs/everstake/repos`, compares `pushed_at`, and requests commits since the preceding check only for changed repositories.
- Every run appends a change receipt with checked method, new/changed pages, old/new hashes, and literal numeric fact additions/removals. The Freshness view shows the last run and change log.
- A specific canonical page can be fetched on demand through `live_fetch`; the sanitized exact response becomes answer evidence and is audited.

The live calculator exposes Economy, Balanced, Real-time, and custom policies. Its unit measurements are regenerated from the current **304-document/1,223-chunk** index; workload rates remain explicit planning assumptions rather than forecasts. The money is almost entirely conditional embedding after expected changes; extraction and consistency checks are deterministic and cost $0 in model tokens.

The real 2026-09-12 refresh checked 20 web documents plus 69 GitHub repositories, downloaded 8.31 MB, and found two live-page changes (`/staking` and `/products/institutional-staking`). It re-indexed 1,075 chunks / 776,784 tokens for **$0.01553568** in **69.27 seconds**, preserving both prior snapshots and recording the changed numeric facts. This remains far below the task's $0.50 refresh ceiling.

## Provenance and tamper evidence

`data/corpus.jsonl` is the normalized source-snapshot store: each document carries final URL, publication/modified/fetch timestamps, source tier, and SHA-256. Changed versions are preserved under `data/snapshots/<sha256>.json` by the refresher. Tool evidence receives a second hash over the exact sanitized bytes seen by the model.

Every result, including abstention, appends an audit record containing the question, answer, as-of date, exact cited evidence, hashes, and tool trace. Records form `SHA-256(previous_record_hash || canonical_record)` chain and are signed with a persistent Ed25519 key. `GET /api/audit/<id>` returns the record and verifies the signature plus every preceding link; `GET /api/audit/public-key` exposes the raw base64 public key and algorithm. The private key is mode `0600`, kept only in the persistent runtime volume. This makes offline edits detectable. Production should additionally ship the chain head to write-once object storage or an external transparency log, because root access to both key and log is outside this single-host threat model.

Untrusted content is sanitized before retrieval. Sentence-level injection patterns remove instructions while preserving adjacent facts; removed samples remain in the index audit fields. The same boundary is applied to live pages. User questions have a deterministic override/exfiltration guard. URL parsing rejects userinfo/host-confusion SSRF, redirects are rechecked, MCP exposes a positive read-only list, citations are server-resolved, and absence claims cannot masquerade as supported answers with topic-adjacent links.

## Evaluation and measured cost

The final adversarial run is in `EVAL.md` and `data/adversarial-results.json`: **24/24 passed, 0 failed**. The four additions plant a false negative page, a contradicting employee interview, a look-alike video, and an outdated third-party number. Twenty controls are deterministic and four execute the full model/tool/audit path. The final run cost and latency are recorded row by row in `EVAL.md`; all work for this source expansion used about **$0.084** in model/embedding API calls, safely below the $1 ceiling.

The speaker-aware rebuild produced 1,223 chunks from **873,426** provider-reported embedding tokens, costing **$0.01746852**. The final four-agent adversarial subset cost **$0.02499372**. Gemini 3.8 Flash is priced in the dated table at $0.75/M input and $3.75/M output during the recorded introductory period; OpenAI remains only the $0.02/M embedding provider. All paid calls append to `data/run-costs.jsonl`; structured resource runs append to `data/accounting.jsonl`.

## Scale sketch: 6,000–10,000 call recordings

Assumption: average call length 30 minutes. That is 3,000–5,000 audio hours. At Soniox's September 2026 public async equivalent of roughly **$0.10/audio hour**, first-pass transcription is **$300–$500**; real-time at $0.12/hour would be $360–$600. Soniox's reference of about 15,000 output text tokens/hour implies **45–75 million transcript tokens**. Embedding all text with `text-embedding-3-small` at $0.02/M is only **$0.90–$1.50**; storage and governance dominate model cost. At the current index ratio, vectors/text/metadata land around 0.5–0.9 GB, but budgeting **2–5 GB** covers diarization, word timestamps, redacted/original variants, and indexes.

Ingestion would be an encrypted object-store queue: audio hash → EU-region async STT with diarization and domain terms → quality/confidence gate → deterministic PII/entity detection → two transcript views. The serving index gets a redacted view; tightly scoped compliance storage retains encrypted originals. Tenant/client ACLs are attached before chunking and enforced before retrieval, never left to the model. Names, emails, phones, wallet/account identifiers, balances, and negotiation terms are tokenized or masked; a separately encrypted mapping supports authorized legal discovery.

Retention should be policy-driven: raw audio 30–90 days by default, redacted transcript 12 months, and deal-critical records under explicit legal-hold schedules. Deletion propagates by source ID through transcript, chunks, vector entries, caches, and audit tombstones while retaining a non-content deletion receipt. A 200-call stratified human QA sample should establish word-error rate for accents, numbers, currencies, and speaker attribution before bulk indexing; low-confidence financial numbers go to review. At 10,000 calls, the practical production stack is object storage + relational metadata/ACLs + pgvector or another ANN index, with per-client encryption keys, retrieval audit, DLP monitoring, and no cross-tenant synthesis.

## Deliberate cuts and remaining risks

I did not add authentication, tenant ACLs, external immutable storage, a human approval console, or production observability because the public take-home remains a single-host demo. Changed-document depth incrementally replaces only that document's chunks; a full-depth change recomputes cross-document duplicate groups and boilerplate globally. Ed25519 proves log integrity relative to the public key, but the same-host root/key compromise still needs an external chain-head anchor. Injection detection is deterministic and tested, not a substitute for a versioned classifier and analyst review at call-recording scale. The 24 cases are intentionally adversarial but still author-written; a production launch needs independent blind evals, numeric entailment grading, latency/error SLOs, and red-team ownership.
