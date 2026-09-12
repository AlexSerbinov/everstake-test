You are continuing YOUR OWN work in this directory (`codex-work/`): read `SUMMARY.md`, `REPORT.md`, `README.md` and the code first. It is deployed at https://everstake-codex.89-167-19-222.sslip.io (port 4321, `/data/everstake-codex`, Caddy; `ssh -i ~/.ssh/id_rsa root@89.167.19.222`; touch nothing you did not create). Keys in `./.env`. Do not read or touch `../claude-work/`. Commit as you go (only paths under `codex-work/`), do NOT `git push`.

Two things:

1. **Models: Gemini 3.x only.** The owner does not want any Gemini 2.5 anywhere and prefers Gemini over OpenAI for generation. Move the deployed answer/agent path from gpt-4.1-mini to `gemini-3.8-flash` (function calling via the Gemini API) and any cheap/judging path to `gemini-3.5-flash-lite` (note: Gemini 3.x rejects `thinkingConfig.thinkingBudget`; omit thinkingConfig to keep thinking off on Lite). Keep OpenAI only for embeddings. Update prices (3.8 Flash: $0.75 in / $3.75 out per MTok, intro until 2026-12-31; 3.5 Flash-Lite: $0.30 / $2.50), re-run your eval and adversarial suites, update EVAL/REPORT numbers honestly.

2. The task in `../docs/cost-task.md` — read it fully and implement all four parts in your own way for your version (accounting per stage and per question with real provider usage numbers and real CPU/RAM/time, generated `COST.md`, a dedicated beautiful "Cost" view in your UI plus an expandable per-answer receipt, docs). Keep API spend under ~$2 total for both items and record it.

Deploy, verify the public URL, update SUMMARY.md with what changed and the headline cost numbers.
