# everstake-kb — knowledge assistant over Everstake's public corpus

Answers questions about Everstake from **a corpus we crawled ourselves** (site, docs, GitHub, press, video subtitles), never from the model's memory. Every answer carries an **as-of date** and **cited source URLs**; when the corpus lacks the fact the system says **"no reliable answer"**.

- Live demo: **https://everstake.89-167-19-222.sslip.io** (UI) · `POST /ask` (API)
- Reports: [`REPORT.md`](REPORT.md) (architecture, decisions, measured cost) · [`EVAL.md`](EVAL.md) (20 questions, honest breakdown) · [`PROCESS.md`](PROCESS.md) (Part B)
- Agents / skills / prompts are real files: [`agents/`](agents), [`skills/everstake-kb/SKILL.md`](skills/everstake-kb/SKILL.md), [`prompts/`](prompts)

```
question ─► FTS5 (BM25) ∪ cosine ─► RRF ─► × recency × authority ─► top-k + date-diverse
                                                                        │
     fact ledger (key, value, as_of, source)  ───────────────────────────┤
                                                                        ▼
                                      Claude Opus 5 (structured JSON) ─► citation check ─► answer / "I don't know"
```

## Run it (5 commands)

Requires **Node ≥ 22.13** (SQLite is built into Node — no native modules) and `yt-dlp` on PATH for the video source (optional).

```bash
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) and OPENAI_API_KEY (embeddings)
npm run pipeline              # crawl → dedup → index (chunks, FTS, embeddings) → facts   (~15 min, ≈ $2.6)
npm run serve                 # http://localhost:4320
npm run ask -- "Who is the CEO of Everstake?"
```

Each stage can be run alone and is idempotent: `npm run crawl`, `npm run dedup`, `npm run index`, `npm run facts`.
`npm run eval` runs the 20-question evaluation and regenerates `EVAL.md`; `npm run cost` prints measured spend and the ×50 extrapolation; `npm test` runs the unit tests for the deterministic parts.

**Without an embeddings key** set `EMBEDDINGS_PROVIDER=none`: retrieval degrades to BM25-only and the trace says so.
**Without an Anthropic key** set `LLM_PROVIDER=openrouter` + `OPENROUTER_API_KEY`: the same Claude models are reached through OpenRouter (this is how the submitted run was produced — see REPORT.md).

## What you get

| Interface | Where | Notes |
|---|---|---|
| Web UI | `/` | Ask, sources, retrieval trace with every score, fact timeline, corpus & duplicates, AI-directed instructions found, eval, live settings |
| HTTP API | `POST /ask {question}` | JSON: `status`, `answer`, `as_of`, `confidence`, `sources[]`, `gate`, `trace` |
| Live config | `GET/PUT/DELETE /api/config` | change ranking weights, filters, model — next question uses them (requirement changes during the defence) |
| MCP server | `npm run mcp` (stdio) | tools `ask_everstake`, `everstake_fact_history`, `everstake_kb_stats` — sits next to Everstake's own MCP in Claude Desktop/Code |
| Claude Code skill | `skills/everstake-kb/SKILL.md` | tells Claude Code to call the API instead of answering from memory |
| Other endpoints | `/api/stats /api/facts /api/instructions /api/dedup /api/cost /api/eval /api/doc/:id /api/docs?q=` | everything the UI shows |

## Layout

```
config/kb.yaml          all knobs (ranking, gates, filters, patterns, prices) — live-overridable
config/sources.yaml     what is crawled, what is excluded and why
src/crawl/              robots.txt, polite fetch with redirect chain, sitemap, HTML/markdown extraction, yt-dlp
src/index/              URL canonicalisation, 3-sieve dedup (url → hash → MinHash), chunking, AI-instruction stripping, fact extraction
src/ask/                hybrid retrieval + explainable ranking, the ask() core with two "I don't know" gates, stats
src/server/             Hono API + static UI, MCP server
src/eval/               20-question runner with Haiku judge, cost report
prompts/ agents/ skills/ the model-facing text as files
public/                 the UI (index.html + app.js + styles.css, no build step)
data/kb.db              the whole index in one SQLite file (gitignored)
```

## Deploy

`scripts/deploy.sh` rsyncs the code and the built `kb.db` to a host, builds the Docker image there, starts it on port 4320 and adds a Caddy site block for `everstake.89-167-19-222.sslip.io`. Only the API key(s) in `.env` are needed on the host; the index is built locally.
