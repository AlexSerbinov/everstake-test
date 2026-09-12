---
repo: chkrootkit
url: https://github.com/everstake/chkrootkit
language: Shell/C
stars: 0
created: 2023-12-05
last_commit: 2024-04-23
license: none found (upstream COPYRIGHT present)
topics: []
description: "fork of https://www.chkrootkit.org"
---

## What it is
Everstake's copy/mirror of `chkrootkit` v0.58, the well-known third-party Unix rootkit scanner (not Everstake's own code). Description explicitly says "fork of https://www.chkrootkit.org".

## What it does technically
- Standard chkrootkit distribution: main `chkrootkit` shell script (3079 lines) plus small C helper utilities (`chkproc.c`, `chkdirs.c`, `chklastlog.c`, `chkwtmp.c`, `chkutmp.c`, `ifpromisc.c`, `strings.c`, `check_wtmpx.c`) and a `Makefile`.
- Not a GitHub "fork" in the platform sense (org repo list shows `fork: false`) — it's a manually imported copy of upstream source, version 0.58, tagged `v0.58` in this repo.

## Facts about Everstake it reveals
- Everstake maintains a copy of chkrootkit in its own org — consistent with running host-level security scanning on its validator infrastructure. No Everstake-specific modifications were found in the files sampled (README, chkrootkit script header still credits the original authors, Nelson Murilo and Klaus Steding-Jessen).
- Not evidence of a distinct Everstake product; it's operational tooling reuse, worth excluding from "products" framing.

## Dates
- Created: 2023-12-05.
- Last commit: 2024-04-23 ("Update with additional files").
- Tag: `v0.58` (matches upstream chkrootkit version, not an Everstake release scheme).

## Freshness signals
Tag name mirrors upstream chkrootkit's own versioning. If Everstake pulls a newer upstream release, expect a new tag/commit; otherwise this is a frozen vendor copy, not actively developed by Everstake.
