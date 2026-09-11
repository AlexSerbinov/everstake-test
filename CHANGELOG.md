# Changelog — Everstake test assignment

Timeline of the work, real clock (Europe/Madrid, 2026-09-11). The assignment asks for "how you got there", not only the result, so this file is kept alongside the git history.

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

## Open

- PROCESS.md (Part B) — written by the candidate, not the agent.
- Eval re-run on Claude Opus 5 once a funded key is available.
