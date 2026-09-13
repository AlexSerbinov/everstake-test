# Changelog — Everstake test assignment

Timeline of the work, real clock (Europe/Madrid). The assignment asks for "how you got there", not only the result, so this file is kept alongside the git history — and the git timestamps are real, not rewritten.

**Effort:** measured from prompt and dictation timestamps, not from session length — see [`docs/TIME.md`](docs/TIME.md): **3.3 h hands-on as of 2026-09-12 18:04**, plus the agents' unattended runs listed there. (Until 2026-09-12 this line said "roughly 7–8 hours"; that was the wall-clock span of two sessions including the hours when only agents were running.)

Repository map: [`README.md`](README.md) · documentation index: [`docs/README.md`](docs/README.md).

## 2026-09-11

- **17:04** — Test assignment received from Everstake HR in Telegram: `TEST ASSIGNMENT AI Automation & Agentic Systems Lead.docx` + `corpus_sources.csv` (60 seed URLs). Completion window: 5 calendar days → deadline 2026-09-16.
- **19:20** — Working folder created. Files pulled from Telegram, the assignment translated to Ukrainian word-for-word for reading (`docs/TEST_ASSIGNMENT_UA.md`). ~40 minutes of reading and writing down requirements and open questions.
- **19:30–20:15** — Research before any code:
  - Read `everstake.com/ai-info` and `/mcp`; found the CEO trap (press says Kinitsky "joins as CEO" 06.2025, company page lists Vasylchuk CEO / Kinitsky CCDO) and the "Guidelines for AI assistants" section.
  - Cloned `github.com/everstake/mcp`, called the live server at `mcp.everstake.com` over JSON-RPC: 11 tools, 27 live chains vs "130+" in the static profile, ~1.7k tokens of tool descriptions per request, 20 MB RSS for the Go binary.
  - Crawlability survey of all 60 seed URLs by a research agent (`docs/crawl-survey.md`): robots.txt for 28 hosts, sitemaps (735 URLs on everstake.com), redirects (`.one` → `.com`), the corrupted number `735,,,,` in signalplus' meta description, no hidden text.
  - Evaluated an old in-house TypeScript project as a scaffold (`docs/localtrade-assessment.md`): rejected, only the deploy scheme reused.
  - Decisions: TypeScript, no RAG framework, SQLite, Claude Opus 5 + Haiku 4.5, deploy on a personal Hetzner host via sslip.io. Written plan: `docs/PLAN.md`.
- **20:20** — Turnkey build started by Claude Code (Claude Fable 5.1) from the plan; the human's role from here is review. Everything under `claude-work/` is that run, unedited.
- **20:26** — Crawl running (sitemap + docs + GitHub + press + YouTube subtitles).
- **20:39–20:40** — Stage-by-stage commits: scaffold, crawler, dedup, index, facts, ask, api+ui, mcp+skill+agents, eval+cost, docker+deploy.
- **20:45** — Index built (2 138 chunks, embeddings) and fact ledger extracted (Haiku 4.5, $2.14).
- **20:50** — First live test: CEO question answered *wrong* (Kinitsky) → added the "live page as of fetch date" rule and ledger hygiene → answered right (Vasylchuk, with 2025 history).
- **21:00** — First eval run: 9 questions graded (all correct), then OpenRouter daily limit hit; provider errors made distinguishable from abstentions.
- **21:15** — Deployed to `https://everstake.89-167-19-222.sslip.io` (Docker + Caddy). REPORT.md written.
- **21:50** — Out of Claude credits on every key on the machine. Added a Gemini provider (`gemini-2.5-flash` / `flash-lite`), re-ran the full eval: 20/20 graded, 0 hallucinations, 0 wrong, 5/5 negatives abstained, strict 65% / lenient 100%. Fixed the timeline bug found by q15 (ledger handed only 2026 values). Redeployed.
- **22:20** — Assignment checklist (`docs/CHECKLIST.md`), design brief for a UI pass (`docs/design-brief.md`).
- **22:30** — GitHub repository created; a second, independent implementation by a different model (GPT-5.6 via Codex) started in `codex-work/` for comparison, with the same inputs and no design hints.

- **22:00–22:32** — Codex (GPT-5.6) finished its independent attempt in `codex-work/`: Python, 280 documents, 1 075 chunks, Gemini Flash-Lite for answers, deployed at `https://everstake-codex.89-167-19-222.sslip.io`. Own EVAL/REPORT/SUMMARY, 4 commits. Blind-checked afterwards: CEO question correct, negative case abstains, the networks-over-time question drifts to Cosmos IBC chain counts (no timeline).

- **22:45** — Answer model switched to `gemini-3.8-flash` (intro pricing $0.75 / $3.75 per MTok). Full eval re-run: 0 hallucinations, 0 wrong, 5/5 negatives, strict 70% / lenient 95%, $0.011 per question. The networks-over-time question now returns the full trajectory (70+ → 85+ → 130+ historical / 30+ active).

## 2026-09-12

Second session, roughly 23:30 → 04:00 (Europe/Madrid). Goal: replace "one retrieval, one
prompt" with a tool-using agent, make its reasoning visible, and measure whether the freedom
costs accuracy. Detailed write-up: [`docs/reports/2026-09-12.md`](docs/reports/2026-09-12.md).

- **~23:30–01:30** — **Agentic layer** in `claude-work` (`src/ask/agent.ts`): the answer model
  is given six tools — corpus search, fact-ledger history, document read, live fetch of an
  allow-listed page (robots + 1 h cache), Everstake's own MCP for live APY/uptime, and
  `finish` — and picks its own path, up to six calls. Selection rules live in
  `prompts/agent.md`, the human-readable description in `agents/orchestrator.md`. Every gate
  stayed in code: both paths import them from `src/ask/shared.ts`, so the agent cannot relax a
  rule the single-shot path enforces.
- **~00:30–02:00** — **Visible pipeline.** `POST /ask/stream` emits SSE events
  (`stage` / `tool_call` / `tool_result` / `note` / `final`); the rebuilt UI replays them live —
  plan → ledger → search → live page → answer → verification, with per-step timings. First
  screen stays a single question box; everything else moved behind an Explore menu.
- **~01:30** — **Gate 3, number grounding.** Every numeral in an answer must appear in text a
  tool actually returned this run ("1.6 million" is grounded by "1,600,000"). A citation cannot
  catch an invented number — the sentence around it can be perfectly cited — so this gate can.
- **01:33–01:44** — **Adversarial suite** (`eval/adversarial.yaml`): 8 question-level
  injections, 6 planted documents with canary tokens (indexed into a throw-away copy of the
  database through the normal path), 6 false premises. Verdicts are deterministic predicates in
  code, not a judge model. Result: **16 PASS, 4 WARN, 0 FAIL, 0 canary tokens** in any answer.
  All four WARNs are the same shape and the opposite of a breach — the system refuted a false
  premise *with citations* where the case expected a bare abstention.
- **01:48** — **Eval re-run on the agent path**: strict **80%** (was 70% single-shot), lenient
  95%, 0 wrong, 0 wrongly abstained, 1 judge-scored hallucination on n03. Honest read of the
  trade: the agent buys +10 points and one fewer wrong abstention, and pays with one
  over-answered negative case and ~4× cost per question ($0.048, ~10 s).
- **~02:00–03:15** — **Research notes** (`docs/research/`, Ukrainian): freshness strategy,
  scale and tamper-evidence for 6 000–10 000 call recordings, the adversarial plan, an internal
  knowledge system for the COO (material for Part B), and how this project reports on itself.
- **03:22–03:56** — Codex (GPT-5.6) received the same goals and evolved `codex-work/`
  independently: its own tool loop, Ed25519-signed audit receipts, weekly refresh timer,
  20/20 adversarial, $0.26 total spend. Commits, deploy, `docs/reports/2026-09-12.md`.

## 2026-09-12, later — readability pass

Both implementations were rewritten for readability, on the assignment's own condition
("you must be able to explain and modify any line of what you submit"). Behaviour was frozen:
names spelled out, functions kept under ~40 lines, every constant and heuristic given a *why*
comment that says whether its value is measured, taken from a spec, or hand-tuned — an
assumption is labelled as an assumption rather than given an invented justification.

- **The safety net came first.** A characterization-test layer was written before a single
  line was refactored: TypeScript **26 → 147** tests, Python **16 → 283**. It pins the pieces
  that would fail silently — ranking, dedup clustering, robots precedence, the date-priority
  chain, the gates, the audit chain, the injection patterns, the cost arithmetic.
- **Two coverage gaps were closed by extraction**, not by hoping: the `as_of` priority chain
  was welded inside a worker loop (`resolveFactAsOf`) and the JSON extractor was private to a
  provider call (`extractFirstJsonObject`). Both are now pure functions with tests.
- **Behaviour was verified, not assumed.** Beyond the suites: the SQLite schema diffed
  byte-identical between old and new DDL; the Python pipeline re-run old-vs-new over all 280
  corpus documents, 500+ URLs and 252 full `answer()` calls including prompt hashes; both
  markdown renderers reproduced byte-identical output on all 10 stored runs; the UI diffed
  byte-identical DOM and **0 differing pixels** across 9 screenshot pairs; and the server was
  booted against the real 441-document index and asked both a trap question (CEO — answered
  correctly with citations) and an unanswerable one (2024 revenue — abstained).
- **One measurement bug fixed.** `--render` recomputed metrics in memory, wrote `EVAL.md` and
  discarded the recomputed block, so the results JSON kept its pre-`human_verdict` numbers.
  Since `GET /api/eval` serves that JSON, the live demo reported strict 75% while `EVAL.md`
  and `REPORT.md` said 80%. `--render` now writes the run back, `REPORT.md` §3 was corrected
  to the current numbers, and `eval/results/*.json` is no longer gitignored — it is the
  primary evidence for requirement 5.5 and `EVAL.md` cites it by name.
- Repository navigation added ([`README.md`](README.md), [`docs/README.md`](docs/README.md)).

## Open

- PROCESS.md (Part B) — written by the candidate, not the agent.
- Eval re-run on Claude Opus 5 once a funded key is available.

## 2026-09-13 — Claim dates and quantity scope (local)

Investigated the active-versus-lifetime coverage question against public sources and assignment §3.1–3.2/5.1/5.3. Preserved explicit claim date provenance and cumulative scope in API/UI output; retained same-date subject evidence for whole-answer comparison. Added focused scope review, bounded repair coverage and configurable low thinking for constrained JSON calls. Recorded successful and failed paid diagnostics plus desktop/mobile replay in docs/research/network-scope-and-dates. No deployment or Git publication performed for this task.
