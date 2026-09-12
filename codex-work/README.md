# Everstake Evidence Agent

A tool-using, public-knowledge agent for Everstake. It chooses between a dated corpus, exact-value lookup, full-document reads, allow-listed live pages, and Everstake's read-only MCP tools. Every supported answer has source dates, exact evidence hashes, and an Ed25519-signed audit receipt; unsupported questions abstain.

**Live:** https://everstake-codex.89-167-19-222.sslip.io

## Repository map

- `app/agent.py`: bounded Responses API tool loop and deterministic final validation.
- `agents/tools.json`: production function schemas loaded at runtime.
- `prompts/agent-system.txt`: production selection, stop, citation, freshness, and abstention policy.
- `app/tools.py`: corpus, exact-value, document, live-fetch, and MCP adapters.
- `app/audit.py`: content hashes, append-only hash chain, Ed25519 signatures, and verification.
- `app/refresh.py`: change-detecting scheduled first-party refresh and snapshot preservation.
- `app/server.py`, `web/`: JSON API, live SSE pipeline, dark/light responsive UI.
- `app/crawler.py`, `app/indexer.py`, `app/retrieval.py`: original auditable ingestion and hybrid retrieval base.
- `skills/`: concise operational rules for source conflicts, live evidence, abstention, and audit.
- `eval/adversarial.json`, `EVAL.md`: 20 tricky cases and measured outputs.
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

Open http://localhost:4321. The deployed answer path uses the pinned `gpt-4.1-mini-2025-04-14` snapshot for tool selection/final submission and `text-embedding-3-small` for query vectors. Gemini remains only in the legacy baseline code so the first attempt is reproducible.

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
make adversarial    # 20 safety/trust cases, including four full agent runs
make test           # deterministic unit suite
```

The deployed weekly timer is defined in `deploy/everstake-refresh.{service,timer}`. Dynamic APY/APR, uptime, and reward questions do not wait for that timer: the agent queries `https://mcp.everstake.com` at answer time. Only read-only MCP tools are exposed.

## Guarantees and limits

The server, not the model, enforces exact source refs, distinct-source/date coverage for synthesis, URL and MCP allowlists, question-injection blocking, live-content sanitation, and signed evidence capture. It never treats retrieval similarity as proof. The exact abstention is `No reliable answer was found in the corpus.`

This is still a public single-tenant demo. Authentication, per-client ACLs, external immutable chain anchoring, and human review are documented production extensions rather than claims made by this deployment. See `REPORT.md` for trade-offs, costs, the 6,000–10,000-call plan, and remaining risks.
