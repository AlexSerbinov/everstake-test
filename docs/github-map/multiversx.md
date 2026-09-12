---
repo: multiversx
url: https://github.com/everstake/multiversx
language: none (JSON only)
stars: 0
created: 2023-04-12
last_commit: 2023-11-23
license: none found
topics: []
description: "Public repository for multiversx explorer data import"
---

## What it is
A single data file: `keys.json`, containing 101 BLS public keys, described by the GitHub repo description as "data import" for the MultiversX explorer.

## What it does technically
- No code. `keys.json` is a flat JSON array of 101 hex-encoded BLS public keys (96-byte/192-hex-char strings), the key format MultiversX validator nodes use.
- Likely consumed by the MultiversX block explorer to label/attribute nodes as belonging to Everstake.

## Facts about Everstake it reveals
- Everstake runs (or ran) roughly **100 validator/signing keys on MultiversX (Elrond)** — a materially large validator footprint for that chain (`keys.json`, 101 entries).
- Confirms MultiversX as one of the chains listed in the org profile README.

## Dates
- Created: 2023-04-12.
- Last commit: 2023-11-23 ("Update keys.json added all 100 keys").
- No tags/releases.

## Freshness signals
None — a static data file with no version markers or CHANGELOG. Key rotation/additions would only show as new commits touching `keys.json`; nothing has changed since Nov 2023.
