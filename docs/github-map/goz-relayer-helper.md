---
repo: goz-relayer-helper
url: https://github.com/everstake/goz-relayer-helper
language: Shell
stars: 0
created: 2020-06-04
last_commit: 2023-11-16
license: none found
topics: [blockchain, cosmos]
---

## What it is
A helper script for the Cosmos "Game of Zones" (GoZ) adversarial testnet — a 2020 incentivized IBC (Inter-Blockchain Communication) relayer competition. It automates IBC client updates and cross-zone token transfers using the `cosmos/relayer` (`rly`) CLI.

## What it does technically
- Wraps the `rly` (cosmos/relayer) tool: checks/tops-up faucet balances (`rly tst req`), updates IBC light-client state across configured zones (`rly tx raw update-client`), and pushes IBC packet transfers.
- Sends Telegram alerts via the Bot API when a client fails to update, similar pattern to `proxymon`.
- Logs actions with `ts`-prefixed timestamps to `goz_transferer.log`.
- Includes a results screenshot (`img/goz-relayer-helper.png`) referenced from the README.

## Facts about Everstake it reveals
- Everstake ran an IBC relayer and participated in the Cosmos Game of Zones testnet competition, with a Medium post claiming "a nomination for the Liveness Reward" (homepage URL in repo metadata: medium.com/everstake/...).
- Confirms early (2020) Cosmos ecosystem / IBC relayer operations, predating the current Cosmos validator business.

## Dates
- Created: 2020-06-04.
- Last commit: 2023-11-16 ("Update README.md") — a README-only touch, three years after the actual script work; functional code is untouched since the 2020 testnet.
- No tags/releases.

## Freshness signals
None beyond git log/README edits. Content is a snapshot of a one-time 2020 testnet event; not an ongoing tool.
