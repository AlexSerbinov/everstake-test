# Everstate Knowledge Base

A public-source knowledge assistant being rebuilt as one readable TypeScript implementation, combining lessons from the earlier Claude and Codex prototypes.

**Status: rebuild started; the new application has not been implemented or evaluated yet.** The existing folders below are inherited prototypes. Their measured results and deployed demos do not establish the quality or deployment status of the new version.

Start with the [assignment](docs/TEST_ASSIGNMENT_EN.md), [supplied source list](docs/corpus_sources.csv), and [rebuild transition](docs/REBUILD.md).

The intended deployment is `https://everstate-knowledge-base.89-167-19-222.sslip.io` on the owner's personal server. This is a planned address, not a verified live deployment.

## Previous prototypes and deliverables

# Everstake test assignment — AI Automation & Agentic Systems Lead

A knowledge assistant that answers questions about Everstake from **a corpus of public sources the system crawls itself** — every answer carries an as-of date and cited source URLs, and says "no reliable answer" when the corpus does not contain the fact. The assignment is in [`docs/TEST_ASSIGNMENT_EN.md`](docs/TEST_ASSIGNMENT_EN.md). The repository holds **two independent implementations of the same brief**: [`claude-work/`](claude-work) (TypeScript, built by Claude Code from the plan in [`docs/PLAN.md`](docs/PLAN.md)) is **the submission** — it is the one that covers every item of section 8. [`codex-work/`](codex-work) (Python, built by GPT-5.6 via Codex) is a **second, independent run started ~2 hours later** from the same inputs, with no access to `claude-work/` and no architectural hints (its brief: [`docs/codex-task.md`](docs/codex-task.md), [`docs/codex-task-2.md`](docs/codex-task-2.md)); Part B was explicitly excluded from it. It is kept because running one brief through two models is itself a result, and because each ended up stronger somewhere else — `claude-work` on corpus work and on the section-8 deliverables, `codex-work` on tamper evidence (Ed25519-signed audit chain) and scheduled refresh. **Neither is claimed to be better overall:** their numbers come from different models graded by different evaluation harnesses and are not directly comparable.

## Live demos

Both are deployed on a personal Hetzner host behind Caddy (automatic TLS via sslip.io) and were returning HTTP 200 at the time of writing.

| Implementation | Stack | Live URL | Run locally |
|---|---|---|---|
| [`claude-work/`](claude-work) — the submission | TypeScript, Node ≥ 22.13, SQLite (`node:sqlite`, FTS5 + vectors), Hono, no RAG framework | **https://everstake.89-167-19-222.sslip.io** | `cd claude-work && npm install && cp .env.example .env && npm run pipeline && npm run serve` → `localhost:4320`. The index is **not** committed (`data/*.db` is gitignored), so `npm run pipeline` rebuilds it — ~15 min and ≈ $2.6 of API spend per [`claude-work/README.md`](claude-work/README.md). |
| [`codex-work/`](codex-work) — second, independent run | Python 3.11+, SQLite FTS5, OpenAI Responses API tool loop | **https://everstake-codex.89-167-19-222.sslip.io** | `cd codex-work && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cp .env.example .env && make serve` → `localhost:4321`. The built index **is** committed ([`codex-work/data/index.sqlite3`](codex-work/data/index.sqlite3)), so no crawl is needed. |

Both need API keys in `.env` (`claude-work`: an answer-model key + `OPENAI_API_KEY` for embeddings; `codex-work`: `OPENAI_API_KEY` + `GEMINI_API_KEY`).

## Submission map (assignment section 8)

| Required item | Where it is | Note |
|---|---|---|
| Repository / source code | [`claude-work/src/`](claude-work/src) · [`codex-work/app/`](codex-work/app) | ~1 800 lines of TypeScript / ~15 Python modules. No LangChain/LlamaIndex on either side. |
| README with instructions for running the system | [`claude-work/README.md`](claude-work/README.md) · [`codex-work/README.md`](codex-work/README.md) | Both list the exact commands; see the table above for the one-liners. |
| Agents (as files) | [`claude-work/agents/`](claude-work/agents) — `orchestrator.md`, `answerer.md`, `fact-extractor.md`, `judge.md` · [`codex-work/agents/`](codex-work/agents) — `answer-agent.yaml`, `ingestion-agent.yaml`, `tools.json` | `codex-work/agents/tools.json` is loaded at runtime, not duplicated in code. |
| Skills (as files) | [`claude-work/skills/everstake-kb/SKILL.md`](claude-work/skills/everstake-kb/SKILL.md) · [`codex-work/skills/`](codex-work/skills) — `audit-answer`, `live-evidence`, `negative-answer`, `source-adjudication` | |
| Prompts (as files) | [`claude-work/prompts/`](claude-work/prompts) — `agent.md`, `answer.md`, `extract_facts.md`, `judge.md` · [`codex-work/prompts/`](codex-work/prompts) — `agent-system.txt`, `grounded-answer.txt` | |
| **EVAL.md** | [`claude-work/EVAL.md`](claude-work/EVAL.md) · plus [`claude-work/ADVERSARIAL.md`](claude-work/ADVERSARIAL.md) | 20 questions (15 positive, 5 negative) with reference answer, system answer and verdict; metrics and per-failure reasons. `ADVERSARIAL.md` is a separate 20-attack suite graded by code, not by a judge model. For `codex-work` see the note under 5.5 below — its `EVAL.md` holds the adversarial suite, and the 20-question run is JSON only. |
| **REPORT.md** | [`claude-work/REPORT.md`](claude-work/REPORT.md) · [`codex-work/REPORT.md`](codex-work/REPORT.md) | Architecture, decisions, measured cost, what was cut, what one month would buy. `REPORT.md` §3 reports the current agent-path run (strict 80%, 1 invented fact) and, separately, the earlier single-shot run (strict 70%, 0 invented) as the trade the agent layer bought. |
| **PROCESS.md** (Part B) | [`claude-work/PROCESS.md`](claude-work/PROCESS.md) | ⚠️ **Not written.** The file is a heading skeleton with placeholder ellipses. The thinking for it exists in [`docs/research/04-internal-knowledge-for-ivanna.md`](docs/research/04-internal-knowledge-for-ivanna.md) (Ukrainian), but Part B itself is unfinished. [`codex-work/PROCESS.md`](codex-work/PROCESS.md) is a one-line placeholder by design — Part B was excluded from that brief. |
| Working history (git log with real timestamps) | `git log` · [`CHANGELOG.md`](CHANGELOG.md) · [`docs/reports/`](docs/reports) | 27 commits at the time of writing, real timestamps, 2026-09-11 20:39 → 2026-09-12 03:56. `CHANGELOG.md` is the narrative timeline; it currently stops at 2026-09-11 22:45 and does not cover the 2026-09-12 work (see [`docs/reports/2026-09-12.md`](docs/reports/2026-09-12.md) for that). |

## Requirement coverage — `claude-work` (the submission)

| Requirement | Implemented in | Explained in | Note |
|---|---|---|---|
| 3.1 Factual lookup (value + as-of date + source link) | [`src/ask/agent.ts`](claude-work/src/ask/agent.ts), [`src/ask/shared.ts`](claude-work/src/ask/shared.ts) | REPORT §2.7 | `AskResult` always carries `as_of` and `sources[]`; single-shot fallback in [`src/ask/ask.ts`](claude-work/src/ask/ask.ts). |
| 3.2 Synthesis across sources / over time | [`src/index/facts.ts`](claude-work/src/index/facts.ts) (dated fact ledger), `fact_history` tool in [`src/ask/tools.ts`](claude-work/src/ask/tools.ts) | REPORT §2.2 | Works, but weakest area: of q13–q15 in EVAL.md, two are graded `partially_correct`. |
| 4. Corpus ≥ 200 docs, crawl respecting robots.txt, justified in/out | [`config/sources.yaml`](claude-work/config/sources.yaml), [`src/crawl/`](claude-work/src/crawl) (`robots.ts`, `sitemap.ts`, `fetch.ts`, `extract.ts`) | REPORT §2.1 | 441 canonical documents from 459 fetched (REPORT §1). Exclusions are listed with reasons in `sources.yaml`. Video: [`src/crawl/youtube.ts`](claude-work/src/crawl/youtube.ts), reasoning in REPORT §2.6. |
| 5.1 Recency and source authority | [`src/ask/retrieve.ts`](claude-work/src/ask/retrieve.ts), ranking block in [`config/kb.yaml`](claude-work/config/kb.yaml), date priority in [`src/crawl/extract.ts`](claude-work/src/crawl/extract.ts) | REPORT §2.2 | `RRF(bm25, cosine) × recency × authority`; the "live page as of fetch date" rule is what fixes the CEO trap. Every factor is shown per candidate in the UI trace. |
| 5.2 Deduplication | [`src/index/dedup.ts`](claude-work/src/index/dedup.ts), [`src/index/canon.ts`](claude-work/src/index/canon.ts) | REPORT §2.3 | Three sieves (URL canonicalisation → content hash → MinHash). Measured: 18 aliases in 10 clusters. What text similarity cannot catch (a machine translation, an AI rewrite of the same press release) is documented, not implemented. |
| 5.3 Honest "I don't know" | [`src/ask/shared.ts`](claude-work/src/ask/shared.ts) (gate 1 no evidence, gate 2 citation validity, gate 3 number grounding), [`src/ask/grounding.test.ts`](claude-work/src/ask/grounding.test.ts) | REPORT §2.4 | Provider failures are their own gate (`model_error`), never reported as an abstention. Measured: 4 of 5 negative cases abstained correctly; n03 answered with real documented rates instead of abstaining and is counted as the one failure in EVAL.md. |
| 5.4 Instructions embedded inside documents | [`src/index/instructions.ts`](claude-work/src/index/instructions.ts) (sentences cut out at index time into a separate table), patterns in [`config/kb.yaml`](claude-work/config/kb.yaml), citation validation in [`src/ask/shared.ts`](claude-work/src/ask/shared.ts) | REPORT §2.5, [`ADVERSARIAL.md`](claude-work/ADVERSARIAL.md) | 29 sentences in 9 documents stripped. Adversarial suite ([`src/eval/adversarial.ts`](claude-work/src/eval/adversarial.ts), [`eval/adversarial.yaml`](claude-work/eval/adversarial.yaml)): 16/20 PASS, 4 WARN, 0 failures, 0 canary tokens — the 4 WARNs are over-caution, described as such in the file. |
| 5.5 Evaluation set (20 questions, ≥5 negative) | [`eval/questions.yaml`](claude-work/eval/questions.yaml), runner [`src/eval/run.ts`](claude-work/src/eval/run.ts) | [`EVAL.md`](claude-work/EVAL.md) | 20 questions, 5 negative. Measured (EVAL.md): strict 80%, lenient 95%, 16 successful, 3 partially correct, 1 failed, **1 invented fact**, 4/5 correct abstentions. Judge is a model with deterministic overrides; no full manual grading pass was done. Raw per-question run JSON ships with the repo in [`eval/results/`](claude-work/eval/results) (10 runs, 344 KB) — the same file `GET /api/eval` serves, so the live UI, `EVAL.md` and `REPORT.md` report identical numbers. |
| 5.6 Actual (measured) cost + ×50 extrapolation | [`src/eval/cost.ts`](claude-work/src/eval/cost.ts), reading the `llm_calls` table (`npm run cost`) | REPORT §3 | Index: 3 756 273 tokens / **$2.19**. Per question: $0.041 (Opus 5, 9 measured) or $0.011 (Gemini 3.8 Flash, 20 measured). ×50 corpus ≈ **$109** index, per-query unchanged, arithmetic shown. |
| 5.7 Baseline comparison vs `github.com/everstake/mcp` | [`src/ask/tools.ts`](claude-work/src/ask/tools.ts) — `everstake_live_data` calls the live server as a tool | REPORT §4 | Measured against the live server (11 tools, latency, token cost per call) and states plainly where the MCP server wins (anything live: APY, uptime, calculator). |
| **Part B — process redesign** | — | [`claude-work/PROCESS.md`](claude-work/PROCESS.md) | ⚠️ **Not done.** Skeleton only; supporting material in [`docs/research/04-internal-knowledge-for-ivanna.md`](docs/research/04-internal-knowledge-for-ivanna.md) (Ukrainian) and [`docs/research/05-progress-reporting.md`](docs/research/05-progress-reporting.md). |

### The same requirements in `codex-work`

| Requirement | Implemented in | Explained in / measured |
|---|---|---|
| 3.1 / 3.2 answer modes | [`app/agent.py`](codex-work/app/agent.py) (bounded Responses-API tool loop), [`app/retrieval.py`](codex-work/app/retrieval.py) | REPORT — *Architecture*, *Tools and stopping rules* |
| 4. Corpus | [`app/crawler.py`](codex-work/app/crawler.py) → [`data/corpus.jsonl`](codex-work/data/corpus.jsonl) | 280 documents, 1 075 chunks ([`data/index-stats.json`](codex-work/data/index-stats.json)) |
| 5.1 Recency / authority | `source_authority()` and the recency factor in [`app/retrieval.py`](codex-work/app/retrieval.py) | REPORT — *Architecture* |
| 5.2 Deduplication | `duplicate_groups()` in [`app/indexer.py`](codex-work/app/indexer.py) — sha256 exact + simhash near-duplicate | 10 exact pairs, 2 near-duplicate pairs, 270 unique groups ([`data/index-stats.json`](codex-work/data/index-stats.json)) |
| 5.3 Honest "I don't know" | server-side validation of `submit_answer` in [`app/agent.py`](codex-work/app/agent.py); one exact abstention string | README — *Guarantees and limits* |
| 5.4 In-document instructions | [`app/security.py`](codex-work/app/security.py) — `sanitize_untrusted_text()`, `question_injection_reason()` | REPORT — *Provenance and tamper evidence*; [`EVAL.md`](codex-work/EVAL.md) cases 1–12 |
| 5.5 Evaluation set | [`eval/questions.json`](codex-work/eval/questions.json) (20 cases, 5 negative), runner [`app/evaluate.py`](codex-work/app/evaluate.py) | Results are in [`data/eval-results.json`](codex-work/data/eval-results.json) — 20/20 passed, 0 invented facts. ⚠️ **They are not rendered into `codex-work/EVAL.md`**, which contains the 20-case adversarial suite instead. |
| 5.6 Actual cost | cost events appended to `data/run-costs.jsonl` (gitignored), rolled up in [`data/cost-summary.json`](codex-work/data/cost-summary.json) | Index $0.0155 / 776 291 tokens; $0.00064 per RAG query; whole assignment $0.2597. ⚠️ The ×50 projection covers **embeddings only** ($0.776 in `cost-summary.json`); the REPORT's scale section is a different exercise (6 000–10 000 call recordings) asked for by [`docs/codex-task-2.md`](docs/codex-task-2.md). |
| 5.7 Baseline comparison | [`app/tools.py`](codex-work/app/tools.py) uses `mcp.everstake.com` as a tool | ⚠️ **No baseline-comparison paragraph** exists in `codex-work`'s docs. |
| Part B | [`PROCESS.md`](codex-work/PROCESS.md) | Intentionally out of scope for this run ([`docs/codex-task.md`](docs/codex-task.md)). |

## Repository layout

| Path | What lives there | Part of the submission? |
|---|---|---|
| [`README.md`](README.md) | This file — the map. | yes |
| [`CHANGELOG.md`](CHANGELOG.md) | Narrative timeline of the work with real clock times. | yes |
| [`claude-work/`](claude-work) | **The submission.** TypeScript implementation + `README` / `REPORT` / `EVAL` / `ADVERSARIAL` / `PROCESS`, agents, skills, prompts, eval sets, Docker + deploy script. | yes |
| [`codex-work/`](codex-work) | Second, independent implementation (Python, GPT-5.6 via Codex) with its own `README` / `REPORT` / `EVAL` / `SUMMARY`, committed index and UI screenshots. | yes — as a comparison, not as the primary answer |
| [`docs/`](docs) | Assignment inputs, research done before coding, decision notes, task briefs. Index: [`docs/README.md`](docs/README.md). | yes (background) |
| [`docs/research/`](docs/research) | Five research notes written on 2026-09-12 (freshness, scale & trust, adversarial evaluation, internal knowledge, self-reporting). Ukrainian. | yes (background) |
| [`docs/reports/`](docs/reports) | Daily reports for 2026-09-11 and 2026-09-12. Ukrainian. | yes (background) |
| `everstake-mcp/`, `raw/`, `mcp-test/`, `reference/`, `.mcp.json` | Scratch and third-party material — a clone of Everstake's MCP server, raw crawl survey output, MCP probing, an old in-house project evaluated as a scaffold. Gitignored. | **no** — not in the repository |

## How the work was done

The assignment arrived on 2026-09-11 at 17:04 with a 5-day window; the work was done in two short sessions inside that window (2026-09-11 evening and the night into 2026-09-12), well under the 6–8 hours of expected effort. Roughly 45 minutes went into research before the first line of code — a crawlability survey of all 60 seed URLs ([`docs/crawl-survey.md`](docs/crawl-survey.md)), a probe of Everstake's live MCP server, and a written plan ([`docs/PLAN.md`](docs/PLAN.md)) — which is where the CEO contradiction and the "130+ networks" problem were found, before any retrieval existed to hide them. [`CHANGELOG.md`](CHANGELOG.md) is the timeline with clock times and what each step cost; [`docs/reports/`](docs/reports) holds the two daily reports; `git log` has the same story with real commit timestamps. Everything the assistant built is committed unedited, which is also why the gaps above (Part B, the stale figures in `REPORT.md` §3) are stated here rather than quietly fixed.
