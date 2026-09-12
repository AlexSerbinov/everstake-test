---
repo: eigenlayer
url: https://github.com/everstake/eigenlayer
language: none (JSON/image only)
stars: 0
created: 2024-05-09
last_commit: 2026-07-02
license: none found
topics: []
---

## What it is
Metadata files for Everstake's EigenLayer AVS/restaking operator registrations — three separate operator profiles (default, testnet, and a white-labeled "Swell" operator).

## What it does technically
- No code. Three JSON metadata files consumed by the EigenLayer app (`app.eigenlayer.xyz`) to render operator name/logo/description, plus two PNG logos.
- `metadata.json` (mainnet, operator address `0xe483c7f156b25da9be6220049e5111bb41c4c535` per README): name = **"Everstake - DO NOT STAKE"**, description explicitly says Everstake is no longer participating in EigenLayer and tells delegators to unstake/redelegate.
- `metadata-testnet.json`: normal active-looking Everstake operator profile (99.98% reliability claim, 130+ chains).
- `metadata-swell.json`: a distinct operator profile branded "Swell - Everstake", describing Everstake as running Swell Network's EigenLayer operator.

## Facts about Everstake it reveals
- **Surprise: Everstake has withdrawn from being an EigenLayer mainnet restaking operator.** `metadata.json` reads: *"Everstake is no longer participating in EigenLayer. If you have any tokens staked with Everstake, please unstake or redelegate them to another operator."* (`eigenlayer/metadata.json`) — a live, still-updated (2026) repo whose content is a wind-down notice, not a promo.
- Despite the mainnet withdrawal, Everstake still runs a **testnet EigenLayer operator** (`metadata-testnet.json`) and a **white-label operator for Swell Network** (`metadata-swell.json`), so its EigenLayer relationship is partial, not fully terminated.
- Everstake operates delegated/white-label restaking infrastructure for at least one named partner protocol (Swell Network), which is a distinct product motion from running its own branded operator.

## Dates
- Created: 2024-05-09.
- Last commit: 2026-07-02 (PR "update-metadata-april-2026") — actively maintained, contradicting a naive assumption that "no code changes" means "dead repo".
- No tags/releases (plain metadata repo).

## Freshness signals
Purely content-driven: watch for changes to any of the three `metadata*.json` files (name/description edits) as the strongest signal of a change in EigenLayer operator status. No version numbers exist to check.
