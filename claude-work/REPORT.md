# REPORT — Everstake knowledge assistant

_Test assignment, AI Automation & Agentic Systems Lead. Live: https://everstake.89-167-19-222.sslip.io · code: this repository · measured results: [EVAL.md](EVAL.md)_

## 1. What was built

A question-answering system over **a corpus of public Everstake sources that the system crawled itself** (442 canonical documents after deduplication, from 460 fetched), with two modes — factual lookup (value + as-of date + source) and synthesis across time — and an honest "no reliable answer". Interfaces: web UI, HTTP API, MCP server, Claude Code skill. One TypeScript codebase, ~1 800 lines, one SQLite file, no RAG framework.

```
config/sources.yaml ──► CRAWL ──► DEDUP ──► INDEX ──► FACTS ──► kb.db ──► ASK ──► UI / API / MCP / skill
                    robots.txt  url→hash   chunks    Haiku            hybrid retrieval
                    redirects   →MinHash   FTS5      ledger           × recency × authority
                    dates       1 canonical embeddings                 Opus 5 → JSON → citation check
                    soft-404   per cluster AI-instr.
                                          stripped
```

## 2. Architecture and the decisions behind it

### 2.1 Corpus: 442 documents, chosen rather than accumulated

The seed CSV had 60 URLs; a survey of robots.txt, sitemaps and redirects (done before writing the crawler) showed **~900 documents are reachable** (735 in everstake.com's sitemap alone). So the task was not "reach 200" but "pick the right ones and explain the rest":

| Included | How | Docs | Why |
|---|---|---|---|
| everstake.com (main, reports, events, 250 newest blog posts of 629) | sitemap | 342 | first-party, server-rendered, `lastmod` present |
| docs.everstake.com | `llms.txt` → every page as `.md` | 69 | Markdown, zero cleaning cost |
| GitHub org READMEs + `mcp/tools.yaml` | GitHub API | 11 | technical truth about SDKs/MCP; the baseline's own text is *in* the corpus as a document |
| Press + third-party (chainwire, cryptopotato, blocktelegraph, bitcoinethereumnews, bitget, signalplus, dlnews, polygon, stakingrewards, wikidata) | seed URLs | 7 canonical (+ aliases) | secondary evidence, needed for the dedup/recency traps |
| YouTube (3 seed + newest from @Everstake) | `yt-dlp` auto subtitles | 12 | tier 3, see §2.6 |

**Excluded, with reasons** (`config/sources.yaml`): `*.everstake.one` (every URL 301-redirects to `.com`; the legacy domain's robots.txt disallows AI crawlers — seed entries were fetched once so the redirect evidence exists), Medium and Crunchbase (403 + robots disallow), LinkedIn (serves HTML but robots.txt disallows ~25 AI user agents — *technically possible ≠ permitted*), investing.com (403 on robots.txt itself → treated as disallow), blockchainmagazine (robots + `ai-train=no`, and a verbatim copy anyway), the staking dashboard (client-rendered, 82 characters). `security.everstake.com` answered 403 to our crawler (Cloudflare) — 8 pages lost, noted rather than bypassed.

The crawler identifies as its own user agent. `everstake.com/robots.txt` contains *two contradictory* rule sets for `ClaudeBot`/`GPTBot` (a Cloudflare-managed block that disallows them, and the site's own block below that allows them); for `*` the rules are unambiguous, so the honest choice was to not pretend to be a well-known AI bot.

### 2.2 Recency and source authority (§5.1)

Ranking is explicit and inspectable — the UI shows every factor per candidate:

```
score = RRF(bm25_rank, cosine_rank) × recency(date) × authority(tier) × (ai_directed ? 0.8 : 1)
recency  = max(0.3, 0.5 ^ (age_days / 365))       — halves yearly, never disappears (history stays retrievable)
authority = 1.0 first-party · 0.7 press/third-party · 0.5 ASR video
```

Three things matter more than the formula:

- **Which date.** Sitemap `lastmod` is *not* a publication date — 156 old posts were re-stamped 2026 by the domain migration. We take `article:published_time` → JSON-LD `datePublished` → `<time>` in the article → `Last-Modified`. Numbers are never read from `<meta name=description>` (that is where the corpus's corrupted `735,,,,` lives).
- **Live pages.** An undated evergreen page (about, team, product, docs) describes the present *as of the fetch date*. The prompt receives it as `live_page_as_of="2026-09-11"`, and the rule is: a dated announcement older than that does not override it. This is exactly the CEO trap — a June 2025 press release (syndicated 8×) says David Kinitsky "joins as CEO", a January 2026 blog post still calls him CEO, but the company page fetched in September 2026 lists Sergii Vasylchuk as CEO and Kinitsky as CCDO. Before this rule the system answered "Kinitsky"; after it, "Vasylchuk, with the 2025 change as history".
- **Syndication does not vote.** Aliases are not chunked, so nine copies of one press release are one source (§2.3).

Besides chunks, the answerer receives a **fact ledger**: structured rows `(key, value, as_of, quote, source)` extracted once per document by Haiku. For "how many networks" the ledger literally contains 70 (2022) → 70+ (2024) → 85 (2025-06) → 130+ (2026): the timeline is data, not something the model has to reconstruct.

### 2.3 Deduplication (§5.2)

Three sieves, cheapest first. Results on this corpus: **18 aliases in 10 clusters**.

| Sieve | Method | Found | Example |
|---|---|---|---|
| URL | canonical key (`.one→.com`, `/blog/→/resources/blog/`, tracking params, `<link rel=canonical>` incl. cross-domain) + recorded redirect chains | 9 | `everstake.one/blog/david-kinitsky-joins…` → `.com/resources/blog/…`; cryptopotato's canonical points at chainwire |
| hash | sha1 of normalised text | 6 | `/staking/protocols/aptos` ≡ `/staking/protocols/polygon` (client-rendered shells — later dropped entirely) |
| MinHash | 5-word shingles, 64 permutations, banded LSH → exact Jaccard (same domain, ≥0.5) or containment (cross-domain, ≥0.5) | 7 | blocktelegraph contains 92% of chainwire; bitcoinethereumnews 0.81 |

One canonical document per cluster: highest tier, then earliest date (the origin of a press release). What text similarity *cannot* catch is documented in EVAL/UI: bitget is a machine translation of the press release (3% shingle overlap) and signalplus an AI rewrite (0%) — same event, no shared text. A production version would add an "event key" (entity + date) as a fourth sieve.

### 2.4 Honest "I don't know" (§5.3)

Two gates in code, one in the prompt:

1. **Gate 1, before the model:** nothing retrieved above a score floor and no fact rows → "no reliable answer", cost $0.
2. **Prompt:** structured output with `status: answered | no_reliable_answer`; the model must cite `[n]` per claim.
3. **Gate 2, after the model:** citations must be numbers of sources actually provided; an answer with no valid citation is converted to "no reliable answer".
4. **Gate 3, after the model (`gates.require_grounded_numbers`, default on):** every numeral in the answer must occur in text a tool actually returned this run — matched after stripping thousands separators and across scales, so "1.6 million" is grounded by "1,600,000". A citation cannot catch an invented number, because the sentence around it can be perfectly cited; this can. One number with no provenance converts the whole answer to "no reliable answer" (`gate3_ungrounded_number`). It is the one gate that can refuse an otherwise good answer, which is why it is a config flag and why `src/ask/grounding.test.ts` pins its false-positive behaviour as tightly as its true positives.

Provider failures are a separate gate (`model_error`) so an outage is never reported as an abstention — the first eval run hit an OpenRouter daily limit and this distinction mattered.

### 2.5 Instructions embedded in documents (§5.4)

`everstake.com/ai-info` is a page written *for* LLMs ("Guidelines for AI assistants", "do NOT describe Everstake as…", "cite this page"); `llms.txt` exists on both domains. Handling is architectural, in three layers:

1. **Index time.** Sentences matching a configurable pattern set are **cut out of the chunk text** and stored in a separate `instructions` table (29 sentences in 9 documents). The retriever and the answer model never see them as text. Instructions inside a parenthesis are removed while the factual sentence is kept. The UI tab *AI instructions* lists every one with its URL.
2. **Prompt time.** Context is passed as tagged data (`<source id url published>`), the system prompt states that anything inside is quoted web text, and pages flagged `ai_directed` are labelled as self-declarations and weighted ×0.8.
3. **Output time.** Citations are validated in code (gate 2). No instruction on a page can change which sources exist.

Why not "just prompt it": prompts are advice, tables are facts. A reviewer can `SELECT * FROM instructions` and see exactly what was found; the model cannot be talked out of a table it never received.

**Adversarial results (measured, `ADVERSARIAL.md`).** 20 attacks — 8 injections in the question, 6 planted documents, 6 false premises — graded by code, not by a judge: asking the model under attack whether it fell for the attack is not a measurement, so every verdict is a deterministic predicate over the `AskResult` (`npm run eval:adversarial`). Result on the agent path with Gemini 3.8 Flash: **16/20 PASS, 4 WARN, 0 hard failures, 0 canary tokens in any answer.** The six planted-document cases index poisoned pages into a *copy* of `kb.db` through the normal path (strip → chunk → embed, plus dedup) and assert on the copy before any question is asked: the direct override lands in the `instructions` table while its factual sentence survives, the `display:none`/HTML-comment payload never reaches `documents.text` at all, the 12-copy "founded in 2011" flood collapses into one cluster and loses to everstake.com (answer: 2018), and the look-alike-domain "$71 billion" release loses to the first-party $7B+. All four WARNs are the same shape and are the opposite of a breach: the system refuted a false premise *with citations* ("Everstake never held an SEC license", "Everstake has no native token") where the case expected a bare abstention. Cost of the run: $1.22 for the answers plus $0.29 of spend inside the throw-away database.

### 2.6 Video

Included: **transcription cost is zero** — YouTube already has auto-generated subtitles for every video (no human captions exist), fetched with `yt-dlp`. Value is low: the three seed videos are 2021–2024 interviews, and ASR mangles names and tickers. So video is tier 3 (authority 0.5), dates come from `upload_date`, and 10 of 23 channel videos were dropped for having no usable subtitles. A search for "Everstake" on YouTube also returns *EverRise* token videos — the exact confusion `ai-info` warns about — so only the official channel and the seed URLs were used.

### 2.7 The agentic layer (`src/ask/agent.ts`)

The single-shot path does one retrieval and hopes it was the right one. Three question shapes defeat that: a value that *changed* (needs the dated ledger, not a chunk), a question about *now* against an undated evergreen page (needs a live fetch), and a question whose wording does not match the corpus's (needs a second search with different words). So the answer model is now given six tools — `search_corpus` (the same `retrieve()`, same scores), `fact_history`, `get_document`, `fetch_live_page` (allow-list + robots + 1 h cache), `everstake_live_data` (Everstake's own MCP, always labelled "live, Everstake MCP") and `finish` — and decides for itself, up to six calls. Asked who the CEO is, it reads the ledger, sees two names, and fetches `everstake.com/company/about` live to settle it: *"David Kinitsky was appointed CEO in June 2025 … the company page as of 2026-09-12 lists Sergii Vasylchuk as CEO and Kinitsky as CCDO"* — a contradiction the one-shot path could only report, not resolve.

**It is still explainable, and still not trusted.** Every guarantee stayed in code rather than moving into the prompt: sources reach the model as tagged `<source>` data with instruction sentences already stripped; source numbers are minted once per run by a `SourceRegistry`, and `finish.citations` are intersected with that registry, so an invented `[9]` is dropped and an answer with nothing left is downgraded to "no reliable answer" (gate 2); no tool returning any source is gate 1; a provider failure is `gate: model_error`, never a quiet abstention. Both paths import those checks from `src/ask/shared.ts`, so the agent cannot relax a rule the single-shot path enforces. And because every decision is streamed (`POST /ask/stream`: `stage` / `tool_call` / `tool_result` / `note` / `final`) and stored in `questions_log.response.steps`, "why did it say that" is answered by replaying the run rather than by trusting it. The cost of the freedom is honest: ~$0.02–0.04 per question against ~$0.01 single-shot, because each tool result grows the context of the next turn.

### 2.8 Technology

TypeScript on Node 22+, SQLite via `node:sqlite` (FTS5 built in, vectors as BLOBs, cosine in-process over 2 146 chunks — a vector database for 2 000 rows would be ceremony), Hono, Claude Opus 5 for answers (adaptive thinking, effort medium) and Haiku 4.5 for extraction/judging, OpenAI `text-embedding-3-small` for vectors. No LangChain/LlamaIndex: the whole pipeline is ~1 800 lines that can be changed live, which is what the defence requires.

**Provider note.** The code has three interchangeable LLM providers behind one `complete()/completeJson()` function (`src/llm.ts`): the official Anthropic SDK (default, with prompt caching on the system prompt), OpenRouter (same Claude models through an OpenAI-style API), and Gemini (`gemini-3.8-flash` for answers, `gemini-3.5-flash-lite` for extraction/judging). The index (fact ledger) was built with Claude Haiku 4.5 via OpenRouter; the **submitted EVAL.md run used Gemini 3.8 Flash** because the Claude budget on hand ran out mid-evaluation — a one-line `.env` switch; the first nine questions answered by Claude Opus 5 before the cut-off were all graded `correct`, and a full run on an older Flash model (strict 65%) is kept in `eval/results/` for comparison. Gemini 3.8 Flash is ~4× cheaper per question than Opus 5 and weaker on synthesis (4 of 5 "partially correct" verdicts are synthesis or extra-detail cases; one product-timeline question was abstained on although the corpus has the pages). The model is a knob in *Settings*; the architecture does not depend on it.

## 3. Measured cost (§5.6)

All numbers are from the `llm_calls` table (every call logs provider usage); `npm run cost` reproduces them.

**The full accounting is [`COST.md`](COST.md), generated by `npm run cost` and committed.** It carries what this section has no room for: every stage with its wall time, CPU, peak RSS, items and bytes downloaded next to its money; one real question priced step by step; the ×50 extrapolation per row with the arithmetic spelled out beside each number; and an explicit list of what is measured versus assumed. The same object is served at `GET /api/cost` and drawn in the UI under **Explore → Cost**, so the file, the API and the page cannot disagree.

**Method.** Two tables, joined by a run id. `llm_calls` has one row per provider call, written by `logCall()` in `src/llm.ts` with the token counts the *provider* reported (`usageMetadata` for Gemini, `usage` for Anthropic and OpenAI) — never a local estimate — and the USD computed at call time from the price table in `config/kb.yaml`. `stage_runs` has one row per execution of a stage, written by `withStageMetrics()` in `src/metrics.ts`, which wraps every CLI command and every question: it records start and end, wall time, CPU (`process.cpuUsage()` delta), peak RSS (sampled `process.memoryUsage.rss()` every 250 ms), items processed, and bytes read off the socket. Calls made inside a stage carry its `run_id`, so a stage's money and its resources come from two tables that agree by construction rather than by bookkeeping. The per-question receipt is *derived* from those same rows — the agent keeps no running total of its own, precisely so there is nothing for the ledger to disagree with.

**What is assumed, in short** (COST.md §4 has the full list). Prices are list prices copied in September 2026, and Gemini 3.x is at an introductory rate that ends 2026-12-31, after which every per-question figure here doubles. A stage row reports its *most recent complete run* — what building the index once costs — not the sum of every attempt; the embedding stage was run six times around an OpenAI rate limit, and summing would have published five times the true figure. Spend logged before per-stage measurement existed (fact extraction, the eval judge, and the Claude Opus 5 / Gemini 2.5 experiments) keeps its exact tokens and dollars but has no time, CPU or memory behind it: those cells read "—", never 0. Time, CPU and RAM are properties of the machine that measured them — an 8-core M1 Pro laptop with 16 GB, not the 2-vCPU VPS the demo is deployed on — and the ×50 wall-clock column additionally assumes the same serial execution, which is exactly the assumption crawling would break first, since it is delay-bound rather than CPU-bound.

The headline figures, as of the run COST.md was last generated from — one complete pass of each stage, not the sum of every attempt:

| Item | Tokens | Cost | Wall | CPU | Peak RSS |
|---|---|---|---|---|---|
| Crawl, 523 targets → 460 documents, 126 MB downloaded | — | $0 | 4m 20s | 13.8 s | 173 MB |
| Dedup, 460 documents → 442 canonical | — | $0 | 0.6 s | 0.6 s | 172 MB |
| Embeddings, 2 146 chunks (`text-embedding-3-small`) | 1 113 259 | $0.022 | 41.5 s | 3.2 s | 207 MB |
| Fact extraction, 445 calls (Haiku 4.5) | 1 387 330 in / 150 769 out | $2.141 | not measured | not measured | not measured |
| **Index build total** | **2 651 358** | **$2.16** | **5m 2s** | | |
| One question, Gemini 3.8 Flash (5 measured under the current build) | ~9 700 in / ~1 400 out incl. thinking | **$0.045** | 13.6 s avg | | |
| One question, Claude Opus 5 (9 measured) | ~8 200 in / ~200 out | **$0.041** | | | |
| One question, Gemini 3.8 Flash (20 measured, the EVAL.md run; intro price $0.75/$3.75 per MTok) | ~8 700 in (≈4 000 cache hits) / ~1 800 out incl. thinking | **$0.011** | | | |
| One question, older Flash model (20 measured, earlier run) | ~7 200 in / ~600 out incl. thinking | $0.0063 | | | |
| Eval judge, per question | ~400 | $0.0006 (Haiku) / $0.0001 (Flash-Lite) | | | |

The two Gemini 3.8 Flash rows differ by 4× and both are real: the EVAL.md run averaged $0.011 across 20 questions, many of them one- or two-tool answers, while the five questions measured under the current build averaged $0.045 because the agent used four to six tools each and Gemini bills thinking tokens as output. What a question costs is therefore a property of how hard the question is, not a constant — which is why COST.md prints the per-question figure with its denominator attached, and prices one specific question line by line instead of quoting an average alone.

**×50 corpus (≈22 000 documents):**
index = $2.16 × 50 = **≈ $108** (linear: every document is embedded and read once by the extractor; with Gemini 3.5 Flash-Lite as extractor ≈ $15).
Per query: **unchanged — $0.04 (Opus 5) or $0.011 (Gemini 3.8 Flash)** — because the model always reads a fixed top-k (10 + 4 chunks + ≤14 fact rows); what grows is retrieval work: BM25 over 107 000 chunks and a brute-force cosine over 107 000 × 1 536 floats (~160 MB) is still tens of milliseconds in-process, but at that size we would move vectors to sqlite-vec or pgvector. 1 000 questions ≈ $40 (Opus) / ≈ $11 (3.8 Flash); with Anthropic prompt caching the system-prompt share of input (~1.5k tokens) costs 10× less.

**Eval headline — current run (`EVAL.md`, agent path, Gemini 3.8 Flash):** 20 questions, **0 wrong, 1 invented fact**, 4/5 negative cases correctly abstained, 0 wrongly abstained, 12/15 positive fully correct, 3 partially correct. Strict accuracy 80%, lenient 95%. The single failure is n03: on a negative case the agent, having more tool calls than the single-shot path, found the pages that *do* publish commission rates and answered with them instead of abstaining — every figure cited and gate 3 passed, but a skim-reader could mistake a public rate for an institutional one, so it is scored as a failure rather than argued away (full reasoning in `EVAL.md`).

**The earlier single-shot run**, on the same 20 questions and the same model, scored strict 70% / lenient 95% with **0 invented facts** and 5/5 negatives abstained, but 1 wrongly abstained. That is the honest trade the agent layer bought: +10 points of strict accuracy and one fewer wrong abstention, paid for with the one over-answered negative case above and ~4× the cost per question.


## 3a. Freshness: how current the corpus stays, and what that costs (§5.5)

An index is a photograph. The rule that resolves the CEO trap in §2.2 — *"an undated live page describes the present as of the fetch date"* — is only true while the fetch is recent, so re-checking is not an optimisation of this system, it is a **precondition for a correctness rule it already relies on**. What follows is the incremental re-check (`npm run refresh`), the scheduler that runs it, the log of what it found, and a calculator that prices any policy *before* it is chosen.

### The three sieves, and why the order is the whole design

Nothing is re-indexed until three progressively more expensive tests have all failed to prove it unchanged (`src/refresh/sieves.ts`, pinned by `sieves.test.ts`):

| # | sieve | cost per document | what it settles here |
|---|---|---|---|
| 1 | sitemap `lastmod` vs the value stored at the last check | **zero requests** — one sitemap read covers 336 pages | most of everstake.com |
| 2 | conditional GET with the stored `ETag` / `Last-Modified` | one request, **no body** on a 304 | docs, press, anything with no sitemap |
| 3 | sha1 of the normalised text vs `content_hash` | body already in hand, no model | pages whose only diff is a banner or a counter |

`lastmod` is trusted here although §2.2 forbids it as a *publication* date, and the two are not in tension: "this page was edited at T" is exactly what a CMS timestamp means, and "this page was written at T" is what it does not. The 156 posts the domain migration re-stamped were genuinely rewritten that day — as a change signal the timestamp was right, as a date it was a lie.

GitHub gets a fourth, cheaper sieve of its own, following `docs/github-map/refresh-plan.md`: one `GET /orgs/everstake/repos` returns `pushed_at` for every repo, so 11 documents are settled by a single request, and a repo that moved is summarised from `commits?since=` into its document rather than by re-reading a README that the commits usually did not touch.

### Policy: interval × depth, per source type

`config/kb.yaml → freshness` sets, for each of seven source types (live pages, blog, docs, reports/events, GitHub, video, press), an **interval** (`hourly | daily | weekly | monthly | never`) and a **depth**:

- `check` — run the sieves and log the change, then touch nothing: not the text, not the hash, not the stored ETag. Storing any of them would make the *next* run report the page as unchanged (or as a 304) while its chunks and facts still describe the old version — stale in fact, fresh in the log. So an unresolved change keeps being reported, at the price of one body fetch per run, until someone raises the depth;
- `reindex` — re-chunk and re-embed the changed document (embedding money, no model);
- `refacts` — also re-run the fact extractor on it. The only depth that can report *"the value of `ceo` changed"*, which is why it is per type and not global.

Three presets ship as named bundles, and the live override goes through the existing `PUT /api/config`, so the UI's controls change what the scheduler does with no restart — the same mechanism the ranking knobs use.

**The policy chosen for the demo is `balanced`**, and the reason is the shape of the corpus rather than a preference for the middle option. The pages where a *value* can silently change are the ~33 undated live pages and the GitHub READMEs — that is where the CEO trap, the network count and the APY figures live — so those are checked daily at `refacts`. The blog is checked daily too, but for the opposite reason: nothing in it is ever edited, and the daily check exists to catch the ~17 new posts a month, which the corpus's own `published_at` histogram measures rather than assumes. Docs move with releases (weekly, `reindex`: the text matters, the fact ledger rarely does). Press is `check` only — a third-party article is not edited after publication, and paying to re-extract facts from someone else's copy of a press release we already hold first-hand is money for nothing. Video is monthly at every preset, including `realtime`: an auto-generated transcript of a finished 2021 interview is not rewritten.

### The calculator, from measured unit costs

`src/refresh/calculator.ts` is a pure function — no database, no clock, no config — over (policy, unit costs, corpus profile), and `calculator.test.ts` pins every branch of it. `units.ts` supplies the inputs from the same two tables COST.md is generated from:

| unit | value | where it comes from |
|---|---|---|
| embedding, per chunk | **$0.0000104** | the index run's own `embed` calls ÷ its 2 146 chunks |
| fact extraction, per document | **$0.00484** | 442 extraction calls, $2.141, one call per document |
| full page fetch | **0.50 s, 252 kB** | the crawl run: 260 s and 132 MB over 523 pages |
| conditional GET | **0.55 s** | measured by a refresh run once one exists; assumed as delay + 0.25 s until then |
| per-run overhead | ~7 s | assumed: 8 discovery requests at the politeness delay + the measured dedup pass |

Arrival rates are measured where the corpus can measure them (203 blog posts published in the last twelve months → 16.9/month; 23 reports and events → 1.9/month) and assumed, *labelled as assumed in the UI*, where it cannot: docs and GitHub READMEs carry no publication date anywhere, so their arrival rate and every type's **edit** rate are stated numbers in `freshness.assumptions`, not measurements. The UI prints both lists side by side, the same measured/assumed split COST.md makes.

**The three presets, priced against this corpus (442 documents, 2 146 chunks):**

| preset | $/month | tokens/month | machine minutes/month | pages checked/month | worst case staleness |
|---|---|---|---|---|---|
| economy | **$0.13** | 161 k | 7 | 2 288 | live pages 24 h, blog and docs a week–month, video never |
| **balanced** (demo) | **$0.15** | 185 k | 17 | 9 650 | live pages, blog, GitHub 24 h; docs, reports, press 7 days; video a month |
| realtime | **$0.17** | 200 k | 292 | 221 567 | live pages, blog, GitHub 1 h; everything else 24 h; video a month |

The interesting result is that **money is nearly flat across the three and machine time is not** — $0.13 → $0.17 against 7 → 292 minutes, a 40-fold spread. That is not a quirk of the arithmetic, it is what the sieves are for: checking is bounded by requests and a change can only be found once per check, so raising the frequency multiplies the *checking* and leaves the *processing* almost untouched. The bill for keeping this corpus current is dominated by the ~17 blog posts a month that must be embedded and read whatever the policy, and the honest conclusion is that on a corpus this size the frequency question is a question about politeness and machine time, not about money. It becomes a money question at ×50: index once ≈ $108 (§3), and the same balanced policy over ≈22 000 documents is roughly $7.50/month — still an order of magnitude below re-indexing.

### The scheduler and the change log

`docker compose up -d` starts two services from one image: `kb` (API + UI) and `refresher` (`node dist/refresh/schedule.js`). The loop is one `setInterval` that wakes every 15 minutes and asks `refresh()` what is due; dueness is computed from `documents.checked_at` against the interval, so there is **no schedule state to lose** — a missed tick, a restart or a redeploy costs a slightly later pass and nothing else. It is a second container rather than a timer in the API process for two reasons: a refresh holds the SQLite write lock while it re-embeds, and the overlap guard is per process, so exactly one process may run it — a property `docker compose ps` can confirm. `deploy/README.md` documents both this and the systemd-timer alternative, and says why the timer is the worse of the two (the cadence becomes a second place where "how often" is written down, free to disagree with `config/kb.yaml`).

Every run writes a `refresh_runs` row and one `refresh_changes` row per observation — new / changed / removed / `fact_changed` (with the old and new value) / `index_stale` / error. The log exists because **the corpus cannot answer "what changed"**: a re-crawled page has overwritten the evidence that it used to say something else. `GET /api/freshness/log` serves it and the UI's *what changed* panel renders it.

### What the real runs found

Three runs against the live corpus, all on the balanced preset. The whole exercise cost **$0.013**.

| run | due | checked | HTTP requests | 304 | unchanged | changed | removed | facts changed | wall | $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 · cold, no stored validators | 442 | 431 | 431 | 0 | 418 | 13 | 5 | 0 | 224 s | $0 |
| 2 · warm, same 431 forced | 431 | 431 | **80** | 3 | 427 | 1 | 5 | 0 | 44 s | $0 |
| 3 · warm + GitHub, all 442 forced | 442 | 442 | 80 | 3 | 427 | 12 | 5 | 10 | 60 s | **$0.0131** |

**The sieves are the story of runs 1 → 2.** The cold run had no ETag and no stored `lastmod` — the initial crawl never recorded any — so every one of its 431 "conditional" GETs came back with a full body. One run's worth of stored validators later, the same forced re-check of the same 431 documents made **80 HTTP requests instead of 431**: sieve 1 settled 351 documents with no request at all, and the run took 44 s instead of 224 s. Five times faster and a fifth of the traffic, for free.

**Five removed pages**, found by run 1 and confirmed by both later ones: past events (`/company/events/ethcc9-cannes…`, Consensus Miami, RARE EVO, ETHGlobal NYC, the Proof-of-Run 5K) that everstake.com has delisted from its sitemap since the crawl. They are *recorded, not deleted* — a sitemap that omits a page may mean the page is gone or that the CMS had a bad morning, and only a 404/410 from the origin marks a document dropped.

**One genuine content change** in every run: `bitget.com`'s copy of the Kinitsky press release, whose hash moves on every fetch (a news aggregator with rotating page furniture). It is `press` at depth `check`, so it cost nothing, was logged as `index_stale`, and — because that depth deliberately stores nothing — it will keep being reported until someone raises the depth, rather than settling into a corpus that is stale and a log that says otherwise.

**GitHub, run 3, with `GITHUB_TOKEN` set.** One `GET /orgs/everstake/repos` listed 15 public repos; the 11 that back documents all had `pushed_at` unknown (nothing had ever recorded one), so all 11 were summarised: 11 `commits?since=` calls, 11 cheap-model summaries of between 5 and 40 commits each, appended to their documents under a dated `## Repository activity` heading, then 26 chunks re-embedded and 11 documents re-extracted. **$0.0131 in total** — 22 model calls. Every later run gets these for nothing unless a repo actually moves, which is the point of the `pushed_at` sieve. Without the token the same call is a 403 on a shared IP (GitHub allows 60 requests/hour per IP, and this machine's budget was already spent); the run logs the 403 and skips the source rather than failing, and the "last refreshed" table shows those 11 documents as never checked instead of pretending otherwise.

**Ten `fact_changed` rows, and none of them is a fact that changed.** This is the most useful thing the run produced, so it is worth stating plainly: re-extracting the eleven GitHub documents produced `products: "Wallet SDK, REST API" → (absent)`, `slashing_events: "0" → "Zero"`, `certifications: "ISO/IEC 27001:2022" → "ISO/IEC 27001"`, and `custody_model → partners` for the same four company names. The underlying READMEs did not say anything new; the extractor answered differently, on text that had had a paragraph appended to it. So the change log currently conflates **"the source changed its mind"** with **"the extractor did"**, and on a corpus where the first is rare the second is most of the signal. Two things follow, and only the first is done: the log records the old and new value side by side, so a human can see at a glance that `"0" → "Zero"` is noise — and the fix, listed in §6, is to compare the extracted `quote` as well as the value and label a row `extractor_variance` when the sentence behind it is unchanged. Reporting it as-is would be the more flattering choice and the less honest one.

**Run 1 also found a bug in itself, and that is the part worth reporting.** It fetched the twelve YouTube documents over plain HTTP, extracted zero characters from the JavaScript shell of a watch page, and dutifully recorded twelve "changes" to the empty string — deleting twelve transcripts and their 27 chunks. (They were restored from `yt-dlp` and re-indexed; the ledger cost of the repair was $0.0003 of embeddings, and the run is still in the log because a change log that is edited afterwards is not a log.) Two fixes came out of it, and both are the kind only a real run produces:

1. **Video is refreshed through `yt-dlp`, not HTTP** — its text never came from the watch page, so the refresher must use the fetcher the crawler used.
2. **A shrink guard in the sieves**: a re-fetch that returns less than half the stored text, or under 120 characters, is an **error**, not a change, and the document is left exactly as it was. A consent wall, a Cloudflare interstitial and an origin that starts serving a client-rendered shell are indistinguishable from "the page is now empty", and losing content is the one refresh outcome that is not self-correcting. `sieves.test.ts` pins all four cases.

A third, smaller fix came from the repair rather than the run: `crawl --only=youtube` and the incremental `npm run index` that followed it briefly became the cost report's headline figures — "the index build processed 27 chunks". `runsForBasis` in `src/eval/cost.ts` now drops explicitly restricted runs and takes the largest complete one, so a partial re-run keeps its row without becoming the price of a build.

### The UI

**Explore → Freshness** is the operator's view of all of this: three preset cards with their monthly figures, a per-type grid of interval dropdown + depth toggle with the row's own price and worst-case delay, live totals and two charts (money by source type; how stale each type may get), an *Apply* button that writes the override, *last refreshed* per type from the documents themselves — so a type the last run skipped still shows its real staleness — the *what changed* panel, and the assumptions in full, split into measured and assumed. Every number on the page comes from `POST /api/freshness/estimate`; the page owns no arithmetic, for the same reason the Cost view does not.

## 4. Baseline: Everstake's MCP server (§5.7)

We measured the live server (`mcp.everstake.com`): 11 tools, 0.1–0.3 s latency, `tools/list` ≈ 1.7k tokens of context, `get_chains` ≈ 4.8k tokens per call. **Where it is better:** anything live — current APY per network (2.93% ETH today vs 3.41% printed on its own marketing page), uptime, the reward calculator; it needs no crawl, no index, no LLM, and costs nothing per call. For "what is Ethereum APY", the MCP server is strictly better and our system correctly has nothing to say. **Where ours is better:** everything with a date or a history. The MCP's static text has no dates, no sources, no people (it does not contain the word "CEO"), says "130+ networks" while its own `get_chains` returns 27 live chains, and cannot answer "who is the CEO", "what changed since 2025", "which number is current" — our system answers those with a source URL and an as-of date, and abstains when the corpus lacks the fact. They are complementary; on the defence both are plugged into one Claude and the model routes between them.

## 5. What was deliberately cut

- **Blog: 250 newest of 629 posts.** Index cost is linear and the old posts contribute history only; the 2019–2022 seed posts were still fetched explicitly.
- **Video: subtitles only,** no Whisper, no channel beyond the newest 20.
- **Judge is a model** (Haiku) with deterministic overrides for abstentions and a `human_verdict` override column; a full manual grading pass was not done.
- **Security page** lost to Cloudflare (8 docs); certifications are still covered by `ai-info`, `about` and blog posts.
- **No auth** on the demo API (rate limit only).
- **Event-level dedup** (same announcement, no shared text) is documented, not implemented.

## 6. With one month

1. **Event keys** for dedup: (entity, date, claim) fingerprints from the fact extractor, so a machine-translated or AI-rewritten copy joins the cluster of its origin.
2. **Fact reconciliation pass**: a second, cheap model call per *key* (not per document) that reads the ledger timeline — now including the `refresh_changes` rows, which record when a value moved — and writes a "current value + supersedes" chain; today the answerer rebuilds this at query time.
3. **Separate a changed fact from a changed extractor.** The refresh log already stores the old and the new value; comparing the extracted `quote` as well would let a row be labelled `extractor_variance` when the sentence behind the value is unchanged — which on this corpus is *all ten* of the `fact_changed` rows the first GitHub refresh produced ("0" → "Zero"). Only then is a `fact_changed` alert worth waking someone for.
4. **Larger, adversarial eval** (100+ questions, paraphrases, questions with a false premise) run in CI on every prompt/config change, with the hill-climbing loop wired to it.
5. **Internal knowledge**: the same pipeline with Slack/meeting-notes connectors and per-source ACLs; the ranking, dating and instruction-stripping layers transfer unchanged, the crawler is the only part that is web-specific.
6. **Prompt caching + batch** on the Anthropic path (index extraction via the Batch API at 50% cost).

## 7. A problem in the corpus the assignment did not mention

- **"130+ networks" is not the number of networks Everstake supports.** Everstake's own 2026 pages say "historically supported 130+" while several 2026 posts (April–July) say "30+ / 35+ active networks", and the live MCP `get_chains` returns 27. The headline figure is a lifetime count; the current count is ~30. Every source in the seed CSV, the reference answer we wrote for q02, and Everstake's MCP profile all conflate the two. The system surfaced this by itself in q15 (and was marked "partially correct" by the judge for saying more than the reference).
- **The company disagrees with itself about who it is.** `terms-of-use` and `ai-info` say the legal entity is *Everstake Validation Services LLC* (Cayman Islands); the footer of every blog post on the same domain says *Everstake, Inc.* Both are first-party, both current.
- **`robots.txt` on everstake.com is self-contradictory** for AI crawlers (a Cloudflare block disallows ClaudeBot/GPTBot, the site's own block allows them), while `llms.txt` invites LLMs to use `status.everstake.one` and `btc-staking.everstake.one` — domains whose robots.txt disallows them.
- **The MCP marketing page is stale against its own MCP**: 3.41% / 6.84% APY printed on `/mcp`, 2.93% / 5.63% served by `get_chains` the same day; "130+ networks" in the static profile, 27 in the live list.
- **`ai-info` (dated 2026-07-01) tells AI assistants to defer to the About page for leadership, then states a leadership line that reads as if the June 2025 change never happened.** The corpus's most authoritative page is itself an example of why "newest wins" needs the live-page rule.
