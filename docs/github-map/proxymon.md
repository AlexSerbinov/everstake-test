---
repo: proxymon
url: https://github.com/everstake/proxymon
language: Shell
stars: 0
created: 2019-11-19
last_commit: 2019-11-20
license: none found
topics: [eosio, telegram-bot]
---

## What it is
A tiny bash "bot" that checks an EOS proxy/table balance via `cleos` and posts a Telegram alert when funds drop below a threshold. Homepage links a live example bot: `https://t.me/colinproxybot`.

## What it does technically
- `proxymon.sh` reads config from `config.ini` (account/scope/table names, threshold, cleos path, Telegram bot token/chat id), queries an EOS smart-contract table with `cleos get table`, parses rows with `jq`/`awk`/`sed`, and on low balance posts to `https://api.telegram.org/bot<TOKEN>/sendMessage`.
- Runs as an infinite loop (`while true; sleep 3600`) — a poor-man's cron/daemon, meant to run under `supervisor`.
- Depends on an external `cleos.sh` wrapper script and a running EOS API node.

## Facts about Everstake it reveals
- Everstake operated an EOS "proxy" (vote proxy) product and needed to monitor its EOS balance for a specific account/table (`config.ini`, `proxymon.sh`).
- Confirms Everstake's early (2019) EOS ecosystem involvement, alongside `eosmon` and `goz-relayer-helper`.
- Example public Telegram bot referenced: `@colinproxybot` (homepage field in GitHub metadata) — a colleague's/staff first-name-branded bot, suggesting informal internal tooling rather than a productized alert system.

## Dates
- Created: 2019-11-19.
- Last commit: 2019-11-20 ("change script and config") — essentially a single day of work, never touched again.
- No tags/releases.

## Freshness signals
None beyond git log; no version markers. Six years untouched — almost certainly abandoned/historical.
