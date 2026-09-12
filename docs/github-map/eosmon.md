---
repo: eosmon
url: https://github.com/everstake/eosmon
language: Shell
stars: 2
created: 2019-10-29
last_commit: 2023-11-16
license: none found
topics: []
---

## What it is
A small collection of shell scripts that export node metrics (RAM, DB size, block height, disk space) from EOS-family blockchains (EOS, Telos, BOS, MEETONE) into Prometheus' node_exporter textfile format, plus a ready-made Grafana dashboard JSON.

## What it does technically
- Each chain gets its own exporter script (`eos_exporter.sh`, `bos_exporter.sh`, `tlos_exporter.sh`) — near-identical shell scripts parameterized by chain name (`KRYPT`/`KRNAME`), reading local `nodeos` data directories and querying `http://127.0.0.1:8888/v1/chain/get_info`.
- Metrics written as Prometheus exposition format (`# HELP` / `# TYPE` + gauge lines) to a file consumed by `node_exporter --collector.textfile.directory`.
- Ships `Nodes_metrics.json`, an importable Grafana dashboard (referenced publicly at grafana.com/dashboards/11070).
- A `docker/` directory is present (not inspected in depth).

## Facts about Everstake it reveals
- Ran EOS-family validator nodes for EOS, Telos (TLOS), BOS, and MEETONE (`eosmon/README.md`, `tlos_exporter.sh`).
- Monitoring relied on plain shell + `jq` + Prometheus/Grafana rather than a dedicated observability platform, at least historically (`README.md`).
- Metrics tracked: total RAM, state DB size/usage/free space, block log size, reversible DB size, head block, free disk space (`tlos_exporter.sh`).

## Dates
- Created: 2019-10-29.
- Last commit: 2023-11-16 ("Update and rename exportToProm.sh to tlos_exporter.sh").
- No tags/releases.

## Freshness signals
No CHANGELOG, no version field, no tags. Only signal is git commit history; last activity Nov 2023 — likely dormant/superseded by internal tooling.
