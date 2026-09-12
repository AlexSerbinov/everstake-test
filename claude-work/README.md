# everstake-kb — knowledge assistant over Everstake's public corpus

Answers questions about Everstake from **a corpus we crawled ourselves** (site, docs, GitHub, press, video subtitles), never from the model's memory. Every answer carries an **as-of date** and **cited source URLs**; when the corpus lacks the fact the system says **"no reliable answer"**.

- Live demo: **https://everstake.89-167-19-222.sslip.io** (UI) · `POST /ask` (API)
- Reports: [`REPORT.md`](REPORT.md) (architecture, decisions, measured cost) · [`EVAL.md`](EVAL.md) (20 questions, honest breakdown) · [`ADVERSARIAL.md`](ADVERSARIAL.md) (20 attacks, graded by code) · [`PROCESS.md`](PROCESS.md) (Part B)
- Agents / skills / prompts are real files: [`agents/`](agents), [`skills/everstake-kb/SKILL.md`](skills/everstake-kb/SKILL.md), [`prompts/`](prompts)

```
                        ┌─ search_corpus ──► FTS5 (BM25) ∪ cosine ─► RRF ─► × recency × authority ─► top-k
                        ├─ fact_history ───► fact ledger (key, value, as_of, source), full dated history
question ─► agent loop ─┼─ get_document ───► full indexed text (instructions stripped)
   (max 6 tool calls)   ├─ fetch_live_page ► allow-list + robots + 1 h cache ─► live_page_as_of = today
                        ├─ everstake_live_data ► mcp.everstake.com (JSON-RPC) — labelled "live, Everstake MCP"
                        └─ finish ─────────► gate 1 (any evidence?)
                                             gate 2 (citations ⊆ sources returned)
                                             gate 3 (every number ∈ a returned source)
                                                                       │
                                                                       ▼
                                                          answer + as-of + sources / "I don't know"
```

Every step is streamed to the UI over SSE, so the pipeline is watched, not guessed at. The
single-shot path (one retrieval → one prompt) is still there as the fallback: `npm run ask -- "…" --single-shot`,
and it is what non-Gemini providers use.

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

```bash
npm run eval                          # 20 questions on the agent path (default), regenerates EVAL.md
npm run eval -- --engine=single       # the same 20 through the single-shot path, for comparison
npm run eval -- --only=q01,q13        # re-ask two questions, keep the rest of the last run
npm run eval:adversarial              # 20 attacks graded by code, regenerates ADVERSARIAL.md
npm run eval:adversarial -- --only=p01 --keep-db   # one case, and keep the poisoned DB copy to poke at
npm run eval:adversarial -- --render  # re-render the report from the last results file, no spend
```

**`npm run eval:adversarial`** is the security counterpart of the eval: 8 injections in the question,
6 planted documents, 6 false premises, and **no judge model** — every verdict is a deterministic
predicate (`must_abstain`, `answer_must_not_contain`, `citations_must_exist`, `no_uncited_numbers`,
`cited_domains_subset_of`, `max_prompt_overlap_chars`, …) in `src/eval/adversarial.ts`. The planted
documents are indexed into a **copy** of `data/kb.db` through the normal path — `stripInstructions` →
chunks → embeddings, plus dedup for the 12-copy flood — asserted on before any question is asked, and
deleted afterwards; the real index is never touched. Any hard failure or canary hit exits non-zero, so
it can gate a deploy. Point the whole process at another index with `KB_DB_PATH=/path/kb.db`.

**Without an embeddings key** set `EMBEDDINGS_PROVIDER=none`: retrieval degrades to BM25-only and the trace says so.
**Without an Anthropic key** set `LLM_PROVIDER=openrouter` + `OPENROUTER_API_KEY`: the same Claude models are reached through OpenRouter (this is how the submitted run was produced — see REPORT.md).

## What you get

| Interface | Where | Notes |
|---|---|---|
| Web UI | `/` | Ask, sources, retrieval trace with every score, fact timeline, corpus & duplicates, AI-directed instructions found, eval, live settings |
| HTTP API | `POST /ask {question}` | JSON: `status`, `answer`, `as_of`, `confidence`, `sources[]`, `gate`, `steps[]` (the tool trace), `trace` |
| Live pipeline | `POST /ask/stream {question}` | the same answer, streamed as it is produced (see below) |
| Adversarial suite | `npm run eval:adversarial` | 20 attacks, code-graded, poisoned corpus in a throw-away DB copy → `ADVERSARIAL.md` |
| Live config | `GET/PUT/DELETE /api/config` | change ranking weights, filters, model — next question uses them (requirement changes during the defence) |
| MCP server | `npm run mcp` (stdio) | tools `ask_everstake`, `everstake_fact_history`, `everstake_kb_stats` — sits next to Everstake's own MCP in Claude Desktop/Code |
| Claude Code skill | `skills/everstake-kb/SKILL.md` | tells Claude Code to call the API instead of answering from memory |
| Other endpoints | `/api/stats /api/facts /api/instructions /api/dedup /api/cost /api/eval /api/doc/:id /api/docs?q=` | everything the UI shows |

## The stream (`POST /ask/stream`)

`text/event-stream`, one JSON object per event. It is a POST, so the browser consumes it with
`fetch` + `ReadableStream`, not `EventSource`.

| event | data | when |
|---|---|---|
| `stage` | `{id, label, status: start\|done\|skip, ms?, detail?}` | a pipeline stage opens, closes, or is skipped. Ids in order: `plan`, `search`, `facts`, `live`, `read`, `answer`, `verify` — the middle four repeat, because the agent loops |
| `tool_call` | `{step, tool, args, label}` | the model asked for a tool; `label` is the human sentence to show while it runs |
| `tool_result` | `{step, tool, summary, ms, items[]}` | the tool answered; `items[]` are the numbered sources it added (`n`, title, url, date, score) |
| `note` | `{text}` | prose the model emitted next to a call ("two sources disagree on the CEO…") |
| `final` | the full `AskResult` | always last on a successful run |
| `error` | `{message}` | provider or stream failure; a `final` with `gate: "model_error"` still follows |

```bash
curl -N -X POST localhost:4320/ask/stream -H 'Content-Type: application/json' \
     -d '{"question":"What is Everstake'\''s current validator uptime?"}'
```

Config for the loop lives in `config/kb.yaml` under `agent:` — `max_steps`, the `fetch_live_page`
allow-list, the live-page cache window and the MCP URL — and is live-overridable like everything else.

## Layout

```
config/kb.yaml          all knobs (ranking, gates incl. require_grounded_numbers, filters, patterns, prices) — live-overridable
config/sources.yaml     what is crawled, what is excluded and why
src/crawl/              robots.txt, polite fetch with redirect chain, sitemap, HTML/markdown extraction, yt-dlp
src/index/              URL canonicalisation, 3-sieve dedup (url → hash → MinHash), chunking, AI-instruction stripping, fact extraction
src/ask/                hybrid retrieval + explainable ranking, the agent loop (agent.ts, tools.ts),
                        the single-shot ask() fallback, the shared gates (shared.ts), stats
src/server/             Hono API + static UI, MCP server
src/eval/               20-question runner with LLM judge (run.ts), 20-attack adversarial runner
                        graded by code with no judge (adversarial.ts), cost report
eval/questions.yaml     20 questions with reference answers (judge-graded)
eval/adversarial.yaml   20 attacks with code-checkable assertions + the planted-document fixtures
prompts/ agents/ skills/ the model-facing text as files
public/                 the UI (index.html + app.js + styles.css, no build step)
data/kb.db              the whole index in one SQLite file (gitignored)
```

## Deploy

`scripts/deploy.sh` rsyncs the code and the built `kb.db` to a host, builds the Docker image there, starts it on port 4320 and adds a Caddy site block for `everstake.89-167-19-222.sslip.io`. Only the API key(s) in `.env` are needed on the host; the index is built locally.
