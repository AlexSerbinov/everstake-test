# Everstake Evidence Agent

A tool-using, public-knowledge agent for Everstake. It chooses between a dated, speaker-aware corpus, exact-value lookup, full-document reads, allow-listed live pages, and Everstake's read-only MCP tools. Every supported answer has source dates, voice/provenance, exact evidence hashes, and an Ed25519-signed audit receipt; unsupported questions abstain.

**Live:** https://everstake-codex.89-167-19-222.sslip.io

## Repository map

- `app/agent.py`: bounded Gemini function-calling loop and deterministic final validation.
- `agents/tools.json`: production function schemas loaded at runtime.
- `prompts/agent-system.txt`: production selection, stop, citation, freshness, and abstention policy.
- `app/tools.py`: corpus, exact-value, document, live-fetch, and MCP adapters.
- `app/audit.py`: content hashes, append-only hash chain, Ed25519 signatures, and verification.
- `app/trust.py`, `data/trust-score.json`: deterministic score components, bands, reasons, and live weights.
- `app/refresh.py`: policy scheduler, HTTP/GitHub change detection, change log, and snapshot preservation.
- `app/freshness.py`, `data/freshness-policy.json`: per-source policy, presets, and measured monthly calculator.
- `app/accounting.py`, `app/render_cost.py`: measured stage/question receipts and generated cost report.
- `app/server.py`, `web/`: JSON API, live SSE pipeline, responsive Ask, Trust, Freshness, Corpus, and Cost views.
- `app/crawler.py`, `app/indexer.py`, `app/retrieval.py`: original auditable ingestion and hybrid retrieval base.
- `app/sources.py`, `config/people.yaml`, `config/kb.yaml`: YouTube discovery, people registry, speaker classification, and voice authority.
- `app/consistency.py`: code-only attributed-fact ledger, contradiction penalties, and unverified flags.
- `skills/`: concise operational rules for source conflicts, live evidence, abstention, and audit.
- `eval/questions.json`, `EVAL.md`: 20-question quality run with per-answer Trust Score and correctness correlation.
- `eval/adversarial.json`, `ADVERSARIAL.md`: 24 attack cases, including a score-40 fake-number counterfactual.
- `COST.md`: generated stage, question, resource, spend, and ×50 accounting.
- `data/corpus.jsonl`, `data/index.sqlite3`: 280 source snapshots and ready-to-query index.
- `screenshots/`: verified dark, light, and completed-answer states.

## Run locally

Python 3.11+ is sufficient.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Add OPENAI_API_KEY and GEMINI_API_KEY
make test
make serve
```

Open http://localhost:4321. The deployed answer path uses `gemini-3.8-flash` with native Gemini function calling and low thinking. Cheap generation and judging uses `gemini-3.5-flash-lite` without a thinking configuration. OpenAI is used only for `text-embedding-3-small` vectors.

## APIs

Synchronous query:

```bash
curl -sS http://localhost:4321/api/query \
  -H 'content-type: application/json' \
  -d '{"question":"Who is the current CEO of Everstake?","mode":"auto"}'
```

Live pipeline:

```bash
curl -N http://localhost:4321/api/query/stream \
  -H 'content-type: application/json' \
  -d '{"question":"What is Solana current APY?","mode":"auto"}'
```

Live Trust Score weights:

```bash
curl -sS http://localhost:4321/api/trust
curl -sS http://localhost:4321/api/trust \
  -H 'content-type: application/json' \
  -d '{"weights":{"source_authority":0.20,"independent_agreement":0.35,"recency":0.15,"grounding":0.20,"extraction_confidence":0.05,"model_self_assessment":0.05}}'
```

Supported query responses expose `trust: {score, band, label, components, independent_sources, disagreements}`; the final SSE `answer` carries the identical object and a preceding `trust` event makes the computation visible in the pipeline. Abstentions return `trust: null`.

Audit verification:

```bash
curl -sS http://localhost:4321/api/audit/public-key
curl -sS http://localhost:4321/api/audit/RECEIPT_ID
```

The record endpoint returns `verified: true` only when the Ed25519 signature, record hash, and all preceding chain links validate. It includes the exact evidence payload used for the answer.

## Rebuild, refresh, and evaluate

```bash
make crawl          # full seed + sitemap crawl
make index          # sanitize, dedupe, embed, build SQLite
make refresh        # known-source change detection; rebuild only on change
make discover:youtube # discover/filter videos and append free timestamped auto-subtitles
make people:sync    # propose registry additions from the indexed About page; never auto-apply
make adversarial    # 24 safety/trust cases, including four full agent runs
make cost           # regenerate COST.md and Cost-view JSON from measured runs
make test           # deterministic unit suite
```

The hourly scheduler in `deploy/everstake-refresh.{service,timer}` executes the configured due intervals; it does not blindly refresh every source hourly. The Balanced policy checks live pages/blog/docs daily, reports/events weekly, GitHub every six hours, and video/third-party sources weekly. HTTP checks stop in order at sitemap `lastmod`, conditional GET/ETag, then extracted-content SHA-256. GitHub checks the organisation repo list's `pushed_at` and requests commits only since the prior check. Dynamic APY/APR, uptime, and rewards still come from the read-only MCP at question time.

Open `#freshness` in the UI for Economy, Balanced, Real-time, and custom controls. It recalculates monthly dollars, model tokens, machine minutes, per-source bars, and worst-case staleness immediately from measured ledger units. `GET /api/freshness` returns the same inputs plus the latest refresh/change log.

Open `#corpus` to filter sources by who is speaking: official channel, known employee on a third-party channel, or third party. Source cards expose speakers, `stated` versus `reported`, trust penalties, and unverified badges. Auto-subtitle transcripts preserve minute markers so a YouTube citation remains inspectable.

Open `#trust` to edit the six weights live. They must total 100%, and model self-assessment is capped at 10%. Each supported answer shows a band-coloured badge and an expandable row-by-row breakdown: weight, component value, point contribution, and a plain-language reason. Source cards label their own authority and whether they support the answer. The score describes evidence quality, not truth.

## Guarantees and limits

The server, not the model, enforces exact source refs, distinct-source/date coverage for synthesis, reported-number phrasing, exclusion of unverified claims, defamation-safe third-party attribution, URL/MCP allowlists, question-injection blocking, live-content sanitation, and signed evidence capture. A third party may report a company claim but cannot establish or override it. The exact abstention is `No reliable answer was found in the corpus.`

This is still a public single-tenant demo. Authentication, per-client ACLs, external immutable chain anchoring, and human review are documented production extensions rather than claims made by this deployment. See `REPORT.md` for trade-offs, costs, the 6,000–10,000-call plan, and remaining risks.
