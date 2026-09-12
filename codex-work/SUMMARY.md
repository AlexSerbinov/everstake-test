# Submission Summary

## What changed in this evolution

The corpus now understands who is speaking. Free YouTube discovery added 24 filtered, timestamped auto-subtitle transcripts; a maintained people registry classifies official-channel, employee-on-third-party, and third-party voices. The index carries speaker, attribution, `stated`/`reported` provenance, configurable voice authority, contradiction penalties, and unverified flags through to answer evidence and UI badges.

A deterministic consistency pass extracted 2,924 numeric facts, detected 38 same-key/period contradictions, penalized 14 documents, and marked 23 reported claims unverified. Code gates require “according to X (date)” for reported-only numbers, hide unverified claims outside explicit claims/rumour questions, and prevent third-party-only negative allegations from being stated as fact. The Corpus view filters by voice and exposes the decision metadata.

The original cited RAG interface is now a bounded Gemini 3 evidence agent. `gemini-3.8-flash` chooses among corpus search, literal fact/number lookup, canonical document read, allow-listed live page fetch, and Everstake's read-only MCP; `gemini-3.5-flash-lite` is reserved for cheap work, while OpenAI is used only for embeddings. Native function calls preserve Gemini thought signatures, and the server still owns citation, temporal-synthesis, abstention, APR/APY, and read-only MCP guarantees.

`POST /api/query/stream` exposes live planning, exact tool arguments, hashed result summaries, verification, and answer events. The interface now adds a dedicated Cost view with headline spend, stage money/time bars, expandable measured runs, and an expandable per-answer receipt. Both themes and mobile/error/abstention states remain intact.

Freshness is now visible and configurable by source type. An hourly scheduler executes seven independent interval/depth policies; web checks short-circuit through sitemap `lastmod`, HTTP validators, and content hash, while GitHub compares the organisation repo list's `pushed_at` and fetches commits since the prior check. The UI shows the refresh/change log and a live Economy/Balanced/Real-time/custom calculator backed by measured ledger units.

Every answer and abstention is appended to a SHA-256 chain and signed with Ed25519. The record contains the exact cited bytes, content hashes, question, answer, as-of date, and tool trace. The public audit endpoint verified the deployed Solana answer with two exact MCP payloads; the private key persists mode `0600` outside the image.

## Measured result

- Deterministic suite: **314/314 tests passed**.
- Source discovery: **24 accepted videos** from 31 inspected; 9 official, 6 employee-on-third-party, 9 third-party.
- Speaker-aware index: **304 documents**, **1,223 chunks**, **873,426 embedding tokens**, **$0.01746852** rebuild cost.
- Final adversarial set: **24/24**, including four new source-trust attacks; source-expansion API spend was about **$0.084**.
- Quality rerun: **19/20**, zero invented facts, **$0.09753750**; the sole miss was an unchanged lexical ShredStream assertion.
- Prior freshness evolution spend was **$0.32063767**; this source-trust evolution added about **$0.084**, keeping cumulative assignment activity below its ceilings.
- `COST.md` records provider usage plus measured wall/CPU/RSS/bytes for every stage and shows row-by-row ×50 arithmetic.
- Public smoke: HTTP 200, Gemini CEO answer **$0.00419260 / 3.19 s**, expandable four-step receipt, signed audit `verified: true`, container **0 restarts**.
- The preceding real refresh checked 20 web documents and 69 GitHub repositories and applied two live-page changes; those historical measurements remain in `COST.md`.
- Balanced projects **$0.20/month**, **9.87M tokens**, **220.8 machine minutes**, and at most **7 days stale** under the disclosed change-rate assumptions.

## Deployment

**https://everstake-codex.89-167-19-222.sslip.io**

The deployment section below is updated after the speaker-aware image is verified. No push is made.

## What I cut

I did not add authentication, per-client ACLs, external write-once chain anchoring, a human review console, incremental embedding of only changed chunks, or production telemetry. Those are explicit requirements before real negotiation data enters the system, but adding superficial versions would weaken rather than improve this public single-host demonstration. The 6,000–10,000-call plan in `REPORT.md` gives quantified STT/indexing/storage costs, EU/PII controls, deletion propagation, and retention. The eval remains a small authored regression suite, not an unseen-accuracy claim.
