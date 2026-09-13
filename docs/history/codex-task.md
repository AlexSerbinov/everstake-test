You are doing a take-home test assignment end to end, autonomously, on your own judgment. Nobody will answer questions mid-way; make decisions yourself and write them down. Deliver a finished, deployed, documented result.

## Inputs

- The assignment, verbatim: `../docs/TEST_ASSIGNMENT_EN.md` (read it fully; every numbered requirement in Part A and section 8 is a deliverable). Part B (`PROCESS.md`) is NOT your job — leave a one-line placeholder.
- Seed URL list: `../docs/corpus_sources.csv`.
- Work only inside this directory (`codex-work/`). It is inside a git repository; commit your own work as you go with real commit messages (only paths under `codex-work/`), do not touch or read anything under `../claude-work/` — that is a separate, independent attempt and must not influence yours.
- API keys are in `./.env` (already present): `GEMINI_API_KEY` (Gemini models, e.g. gemini-3.8-flash / gemini-3.5-flash-lite — use the 3.x generation only) and `OPENAI_API_KEY` (usable for embeddings such as text-embedding-3-small, or for gpt models). No Anthropic key is available. Keep total API spend under about $5 and record what you actually spent.
- Tools available on this machine: node 26, python3, curl, git, docker, yt-dlp, pandoc, ssh.

## Deployment target (mandatory: the assignment requires the reviewers to run it or see it running)

A Linux host you may use: `ssh -i ~/.ssh/id_rsa root@89.167.19.222` (Ubuntu, Docker installed, Caddy is the reverse proxy with automatic TLS at `/etc/caddy/Caddyfile`, sites are added as a block `name.89-167-19-222.sslip.io { reverse_proxy localhost:PORT }` followed by `systemctl reload caddy`). Use the hostname `everstake-codex.89-167-19-222.sslip.io`, port `4321`, and put persistent data under `/data/everstake-codex/` (the root disk is nearly full; `/data` is large). Other services run on this host — do not stop, modify or remove anything you did not create, and do not use other ports. Verify the public URL works before you finish.

## Rules of the road

- Respect `robots.txt` and be polite to the sites you crawl (identify yourself, rate-limit).
- Everything the assignment asks to "report" or "explain" must be in the written deliverables (README, EVAL.md, REPORT.md), with measured numbers, not estimates.
- The code must be something a person can explain line by line during a live defence; prefer clarity over cleverness.
- When you are done, write `SUMMARY.md` in this directory: what you built, the public URL, the measured results, what you cut, and what you would tell the person defending it.
