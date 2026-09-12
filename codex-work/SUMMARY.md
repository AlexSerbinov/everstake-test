# Submission Summary

## What changed in this evolution

The original cited RAG interface is now a bounded Gemini 3 evidence agent. `gemini-3.8-flash` chooses among corpus search, literal fact/number lookup, canonical document read, allow-listed live page fetch, and Everstake's read-only MCP; `gemini-3.5-flash-lite` is reserved for cheap work, while OpenAI is used only for embeddings. Native function calls preserve Gemini thought signatures, and the server still owns citation, temporal-synthesis, abstention, APR/APY, and read-only MCP guarantees.

`POST /api/query/stream` exposes live planning, exact tool arguments, hashed result summaries, verification, and answer events. The interface now adds a dedicated Cost view with headline spend, stage money/time bars, expandable measured runs, and an expandable per-answer receipt. Both themes and mobile/error/abstention states remain intact.

Freshness is now visible and configurable by source type. An hourly scheduler executes seven independent interval/depth policies; web checks short-circuit through sitemap `lastmod`, HTTP validators, and content hash, while GitHub compares the organisation repo list's `pushed_at` and fetches commits since the prior check. The UI shows the refresh/change log and a live Economy/Balanced/Real-time/custom calculator backed by measured ledger units.

Every answer and abstention is appended to a SHA-256 chain and signed with Ed25519. The record contains the exact cited bytes, content hashes, question, answer, as-of date, and tool trace. The public audit endpoint verified the deployed Solana answer with two exact MCP payloads; the private key persists mode `0600` outside the image.

## Measured result

- Deterministic suite: **304/304 tests passed**.
- Fresh measured build: **280 documents**, **1,072 chunks**, **775,151 embedding tokens**, **$0.01550302**, **4.71 min wall time**; the served frozen index remains 1,075 chunks.
- Quality rerun: **19/20**, zero invented facts, **$0.09753750**; the sole miss was an unchanged lexical ShredStream assertion.
- Final adversarial set: **20/20**; four real agent cases cost **$0.02038270**, averaged **3.02 s**, and averaged **$0.00509568/question**.
- Known current-task API spend including the refresh: **$0.32063767**; complete known assignment activity: **$0.58029719**, below the combined ~$2 ceiling.
- `COST.md` records provider usage plus measured wall/CPU/RSS/bytes for every stage and shows row-by-row ×50 arithmetic.
- Public smoke: HTTP 200, Gemini CEO answer **$0.00419260 / 3.19 s**, expandable four-step receipt, signed audit `verified: true`, container **0 restarts**.
- A real refresh checked 20 web documents and 69 GitHub repositories, found and applied **2 live-page changes**, and re-indexed 776,784 tokens for **$0.01553568** in 69.27 seconds.
- Balanced projects **$0.20/month**, **9.87M tokens**, **220.8 machine minutes**, and at most **7 days stale** under the disclosed change-rate assumptions.

## Deployment

**https://everstake-codex.89-167-19-222.sslip.io**

The active container is `everstake-codex:v3-final`, bound only to `127.0.0.1:4321` behind the unchanged Caddy route. Corpus, index, ledgers, snapshots, signing key, and audit chain remain under `/data/everstake-codex/state/`. The former `v2-final` and smoke `v3` containers remain stopped as rollback points; no push was made.

## What I cut

I did not add authentication, per-client ACLs, external write-once chain anchoring, a human review console, incremental embedding of only changed chunks, or production telemetry. Those are explicit requirements before real negotiation data enters the system, but adding superficial versions would weaken rather than improve this public single-host demonstration. The 6,000–10,000-call plan in `REPORT.md` gives quantified STT/indexing/storage costs, EU/PII controls, deletion propagation, and retention. The eval remains a small authored regression suite, not an unseen-accuracy claim.
