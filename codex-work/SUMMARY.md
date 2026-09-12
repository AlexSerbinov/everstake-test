# Submission Summary

## What changed in this evolution

The original simple, cited RAG interface is now a bounded tool-using evidence agent. A pinned GPT-4.1 Mini model chooses among corpus search, literal fact/number lookup, canonical document read, allow-listed live page fetch, and Everstake's own read-only MCP. The model sees production rules and tool schemas from real files in `prompts/`, `agents/`, and `skills/`; it gets five evidence turns, then a sixth schema-bound `submit_answer` turn. The server still owns the guarantees: no model-memory evidence, no unknown citations, distinct sources and real date coverage for synthesis, exact abstention, APR/APY separation, and no mutating MCP tools.

`POST /api/query/stream` now exposes live planning, exact tool arguments, hashed result summaries, verification, and answer events. The redesigned interface keeps the first screen to one question box, adds polished dark/light themes and mobile/error/abstention states, and links every answer to a cryptographic receipt. Screenshots include the public in-progress, completed, and abstained states.

Freshness is hybrid. Live APY/APR, uptime, status, and reward estimates use `https://mcp.everstake.com` at question time. A weekly systemd timer change-checks known first-party pages; changed content preserves the previous hash-addressed snapshot and swaps in a rebuilt index atomically. `live_fetch` covers a specific stale canonical page under exact-host, robots, redirect, type, and size checks.

Every answer and abstention is appended to a SHA-256 chain and signed with Ed25519. The record contains the exact cited bytes, content hashes, question, answer, as-of date, and tool trace. The public audit endpoint verified the deployed Solana answer with two exact MCP payloads; the private key persists mode `0600` outside the image.

## Measured result

- Corpus retained: **280 documents**, **270 unique groups**, **1,075 chunks**, **776,291 embedding tokens**.
- Deterministic unit tests: **16/16 passed**.
- Final adversarial set: **20/20 passed**, including six question injections, six document injections, forged citations, SSRF, mutating MCP, stale leadership, live APY, private-fact abstention, and temporal synthesis.
- Four full agent evals: **5.09 s mean**, **7.50 s max**, **$0.014634 total**.
- Complete assignment API activity: **$0.25965952**; this evolution added **$0.12698956**, safely below the $5 cap.
- Public deployment: HTTP 200 over valid TLS; SSE closes cleanly after `answer`; Solana APY used exactly two MCP calls and returned **5.63% as of 2026-09-12**; audit returned `verified: true`; container has **0 restarts**.
- Weekly refresh timer is enabled; its dry run checked a live source, found **0 changes**, and spent **$0** on indexing.

## Deployment

**https://everstake-codex.89-167-19-222.sslip.io**

The active container is `everstake-codex:v2`, bound only to `127.0.0.1:4321` behind the unchanged Caddy route. Persistent corpus, index, costs, snapshots, signing key, and audit chain live under `/data/everstake-codex/state/`. The previous container/image and `/data/everstake-codex/app-v1` remain stopped as a rollback point; nothing outside this service, its new timer units, or its existing Caddy route was changed.

## What I cut

I did not add authentication, per-client ACLs, external write-once chain anchoring, a human review console, incremental embedding of only changed chunks, or production telemetry. Those are explicit requirements before real negotiation data enters the system, but adding superficial versions would weaken rather than improve this public single-host demonstration. The 6,000–10,000-call plan in `REPORT.md` gives quantified STT/indexing/storage costs, EU/PII controls, deletion propagation, and retention. The eval remains a small authored regression suite, not an unseen-accuracy claim.
