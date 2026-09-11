# Everstake Knowledge Assistant

A deployed, public-corpus knowledge assistant built for the Everstake AI Automation & Agentic Systems Lead take-home. It supports factual lookup and multi-source synthesis, returns an evidence date and source links, and abstains when the corpus does not support an answer.

**Live:** https://everstake-codex.89-167-19-222.sslip.io

## What is included

- `app/crawler.py`: robots-aware, rate-limited sitemap/seed crawler with an explicit host allowlist and audit log.
- `app/indexer.py`: normalization, repeated-template removal, exact/near deduplication, instruction screening, chunking, and embedding.
- `app/retrieval.py`: SQLite FTS5 + cosine retrieval, authority/recency scoring, source contracts, and grounded generation.
- `app/server.py` and `web/`: dependency-light HTTP API and UI.
- `agents/`, `skills/`, `prompts/`: actual reviewer-facing agent, skill, and prompt files.
- `data/corpus.jsonl`: 280 fetched public documents with provenance.
- `data/index.sqlite3`: frozen, ready-to-query index (270 unique document groups; 1,075 chunks).
- `data/crawl-audit.json`, `data/index-stats.json`, `data/eval-results.json`: measured run artifacts.

## Run locally

Python 3.11+ is sufficient (tested with Python 3.14).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Add OPENAI_API_KEY and GEMINI_API_KEY to .env
make test
make serve
```

Open http://localhost:4321. The committed index means crawling and indexing are not required to review the app. Each query uses OpenAI `text-embedding-3-small` for one query vector and Gemini `gemini-2.5-flash-lite` for grounded JSON generation.

Docker uses the same frozen index via a persistent runtime mount:

```bash
mkdir -p runtime
cp data/index.sqlite3 runtime/index.sqlite3
docker build -t everstake-codex .
docker run --rm -p 4321:4321 --env-file .env \
  -v "$PWD/runtime:/app/runtime" everstake-codex
```

Example API call:

```bash
curl -sS http://localhost:4321/api/query \
  -H 'content-type: application/json' \
  -d '{"question":"Who is the current CEO of Everstake?","mode":"factual"}'
```

## Rebuild and evaluate

The seed CSV is provided one directory above this submission. Crawling makes real network requests and intentionally takes several minutes.

```bash
make crawl
make index
make eval
python3 -m app.render_eval
```

`make crawl` identifies itself, checks each origin's `robots.txt`, waits 650 ms between requests to the same host, discovers only publisher sitemap URLs, and fails closed if robots policy cannot be read. The index build records API-reported token usage and cost events. Evaluation inputs and deterministic verdict rules are in `eval/questions.json` and `app/evaluate.py`.

## Retrieval and safety in one minute

Documents receive a source tier from the supplied seed or the official sitemap. The retriever combines FTS5 and 512-dimensional embeddings, then applies authority and date decay. Mutable corporate facts have small explicit source contracts: for example, current leadership comes from `/ai-info` and `/company/about`, not an older appointment announcement. Duplicate groups nominate one canonical document before retrieval.

Web content is untrusted. At ingestion, instruction-like sentences are removed and audited before chunking/embedding; repeated template passages are also removed corpus-wide. The generator receives only sanitized evidence in quoted XML blocks. Its output must cite evidence, and application code validates citations, synthesis source count, evidence threshold, and date contract. The exact abstention is `No reliable answer was found in the corpus.`

## Tests and live-change friendliness

```bash
make test
```

The code deliberately uses small modules and standard-library HTTP/SQLite rather than a framework or opaque RAG library. Authority weights, abstention threshold, chunk size, and source contracts are named functions/constants, so a live requirement change can be made and tested without understanding a framework graph.

## Deployment

The live instance is a single Docker container bound to `127.0.0.1:4321`; Caddy terminates TLS for `everstake-codex.89-167-19-222.sslip.io`. Persistent index and cost events live under `/data/everstake-codex/state/`. The deployed health check is `GET /health`.

