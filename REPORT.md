# REPORT — Everstake knowledge assistant

_Test assignment, AI Automation & Agentic Systems Lead. Live: https://everstake.89-167-19-222.sslip.io · code: this repository · measured results: [EVAL.md](EVAL.md)_

## 1. What was built

A question-answering system over **a corpus of public Everstake sources that the system crawled itself** (441 canonical documents after deduplication, from 459 fetched), with two modes — factual lookup (value + as-of date + source) and synthesis across time — and an honest "no reliable answer". Interfaces: web UI, HTTP API, MCP server, Claude Code skill. One TypeScript codebase, ~1 800 lines, one SQLite file, no RAG framework.

```
config/sources.yaml ──► CRAWL ──► DEDUP ──► INDEX ──► FACTS ──► kb.db ──► ASK ──► UI / API / MCP / skill
                    robots.txt  url→hash   chunks    Haiku            hybrid retrieval
                    redirects   →MinHash   FTS5      ledger           × recency × authority
                    dates       1 canonical embeddings                 Opus 5 → JSON → citation check
                    soft-404   per cluster AI-instr.
                                          stripped
```

## 2. Architecture and the decisions behind it

### 2.1 Corpus: 441 documents, chosen rather than accumulated

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

Provider failures are a separate gate (`model_error`) so an outage is never reported as an abstention — the first eval run hit an OpenRouter daily limit and this distinction mattered.

### 2.5 Instructions embedded in documents (§5.4)

`everstake.com/ai-info` is a page written *for* LLMs ("Guidelines for AI assistants", "do NOT describe Everstake as…", "cite this page"); `llms.txt` exists on both domains. Handling is architectural, in three layers:

1. **Index time.** Sentences matching a configurable pattern set are **cut out of the chunk text** and stored in a separate `instructions` table (29 sentences in 9 documents). The retriever and the answer model never see them as text. Instructions inside a parenthesis are removed while the factual sentence is kept. The UI tab *AI instructions* lists every one with its URL.
2. **Prompt time.** Context is passed as tagged data (`<source id url published>`), the system prompt states that anything inside is quoted web text, and pages flagged `ai_directed` are labelled as self-declarations and weighted ×0.8.
3. **Output time.** Citations are validated in code (gate 2). No instruction on a page can change which sources exist.

Why not "just prompt it": prompts are advice, tables are facts. A reviewer can `SELECT * FROM instructions` and see exactly what was found; the model cannot be talked out of a table it never received.

### 2.6 Video

Included: **transcription cost is zero** — YouTube already has auto-generated subtitles for every video (no human captions exist), fetched with `yt-dlp`. Value is low: the three seed videos are 2021–2024 interviews, and ASR mangles names and tickers. So video is tier 3 (authority 0.5), dates come from `upload_date`, and 10 of 23 channel videos were dropped for having no usable subtitles. A search for "Everstake" on YouTube also returns *EverRise* token videos — the exact confusion `ai-info` warns about — so only the official channel and the seed URLs were used.

### 2.7 Technology

TypeScript on Node 22+, SQLite via `node:sqlite` (FTS5 built in, vectors as BLOBs, cosine in-process over 2 138 chunks — a vector database for 2 000 rows would be ceremony), Hono, Claude Opus 5 for answers (adaptive thinking, effort medium) and Haiku 4.5 for extraction/judging, OpenAI `text-embedding-3-small` for vectors. No LangChain/LlamaIndex: the whole pipeline is ~1 800 lines that can be changed live, which is what the defence requires.

**Provider note.** The code uses the official Anthropic SDK (with prompt caching on the system prompt). The submitted run was produced through OpenRouter (same models, OpenAI-style API) because no funded Anthropic key was available on the machine that day — a one-line `.env` switch. Side effect: no cache hits in the measured numbers; with the Anthropic path the per-query input cost would drop by roughly the cached system-prompt share.

## 3. Measured cost (§5.6)

All numbers are from the `llm_calls` table (every call logs provider usage); `npm run cost` reproduces them.

| Item | Tokens | Cost |
|---|---|---|
| Embeddings, 2 138 chunks (`text-embedding-3-small`) | 2 218 174 | $0.044 |
| Fact extraction, 445 calls (Haiku 4.5) | 1 387 330 in / 150 769 out | $2.141 |
| **Index build total** | **3 756 273** | **$2.19** |
| One question (Opus 5), average | ~8 200 in / ~200 out | **$0.041** (see EVAL.md for the per-run figure) |
| Eval judge (Haiku), per question | ~400 | $0.0006 |

**×50 corpus (≈22 000 documents):**
index = $2.19 × 50 = **≈ $109** (linear: every document is embedded and read once by Haiku).
Per query: **unchanged, ≈ $0.04**, because the model always reads a fixed top-k (10 + 4 chunks + ≤14 fact rows); what grows is retrieval work — BM25 over 107 000 chunks and a brute-force cosine over 107 000 × 1 536 floats (~160 MB) is still tens of milliseconds in-process, but at that size we would move vectors to sqlite-vec or pgvector. 1 000 questions ≈ $40; with Anthropic prompt caching the system-prompt share of input (~1.5k tokens) costs 10× less.

## 4. Baseline: Everstake's MCP server (§5.7)

We measured the live server (`mcp.everstake.com`): 11 tools, 0.1–0.3 s latency, `tools/list` ≈ 1.7k tokens of context, `get_chains` ≈ 4.8k tokens per call. **Where it is better:** anything live — current APY per network (2.93% ETH today vs 3.41% printed on its own marketing page), uptime, the reward calculator; it needs no crawl, no index, no LLM, and costs nothing per call. For "what is Ethereum APY", the MCP server is strictly better and our system correctly has nothing to say. **Where ours is better:** everything with a date or a history. The MCP's static text has no dates, no sources, no people (it does not contain the word "CEO"), says "130+ networks" while its own `get_chains` returns 27 live chains, and cannot answer "who is the CEO", "what changed since 2025", "which number is current" — our system answers those with a source URL and an as-of date, and abstains when the corpus lacks the fact. They are complementary; on the defence both are plugged into one Claude and the model routes between them.

## 5. What was deliberately cut

- **Blog: 250 newest of 629 posts.** Index cost is linear and the old posts contribute history only; the 2019–2022 seed posts were still fetched explicitly.
- **No incremental re-crawl / scheduler.** `npm run crawl` is idempotent (skips stored URLs) and `--force` rebuilds; a cron and change detection are a day of work not started.
- **Video: subtitles only,** no Whisper, no channel beyond the newest 20.
- **Judge is a model** (Haiku) with deterministic overrides for abstentions and a `human_verdict` override column; a full manual grading pass was not done.
- **Security page** lost to Cloudflare (8 docs); certifications are still covered by `ai-info`, `about` and blog posts.
- **No auth** on the demo API (rate limit only).
- **Event-level dedup** (same announcement, no shared text) is documented, not implemented.

## 6. With one month

1. **Event keys** for dedup: (entity, date, claim) fingerprints from the fact extractor, so a machine-translated or AI-rewritten copy joins the cluster of its origin.
2. **Fact reconciliation pass**: a second, cheap model call per *key* (not per document) that reads the ledger timeline and writes a "current value + supersedes" chain; today the answerer does this at query time.
3. **Change detection + scheduled re-crawl** with diffing of live pages — the CEO case shows that "live page as of fetch" is a property that decays.
4. **Larger, adversarial eval** (100+ questions, paraphrases, questions with a false premise) run in CI on every prompt/config change, with the hill-climbing loop wired to it.
5. **Internal knowledge**: the same pipeline with Slack/meeting-notes connectors and per-source ACLs; the ranking, dating and instruction-stripping layers transfer unchanged, the crawler is the only part that is web-specific.
6. **Prompt caching + batch** on the Anthropic path (index extraction via the Batch API at 50% cost).

## 7. A problem in the corpus the assignment did not mention

- **The company disagrees with itself about who it is.** `terms-of-use` and `ai-info` say the legal entity is *Everstake Validation Services LLC* (Cayman Islands); the footer of every blog post on the same domain says *Everstake, Inc.* Both are first-party, both current.
- **`robots.txt` on everstake.com is self-contradictory** for AI crawlers (a Cloudflare block disallows ClaudeBot/GPTBot, the site's own block allows them), while `llms.txt` invites LLMs to use `status.everstake.one` and `btc-staking.everstake.one` — domains whose robots.txt disallows them.
- **The MCP marketing page is stale against its own MCP**: 3.41% / 6.84% APY printed on `/mcp`, 2.93% / 5.63% served by `get_chains` the same day; "130+ networks" in the static profile, 27 in the live list.
- **`ai-info` (dated 2026-07-01) tells AI assistants to defer to the About page for leadership, then states a leadership line that reads as if the June 2025 change never happened.** The corpus's most authoritative page is itself an example of why "newest wins" needs the live-page rule.
