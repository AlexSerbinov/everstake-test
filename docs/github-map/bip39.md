---
repo: bip39
url: https://github.com/everstake/bip39
language: Go
stars: 24
created: 2023-12-14
last_commit: 2025-06-20
license: MIT
topics: [argon2, argon2id, bip39, bitcoin, blockchain, cryptography, ethereum, go, golang, mnemonic]
---

## What it is
A command-line tool (and Go library) to generate and verify BIP39 mnemonic seed phrases, with an added Argon2id hash of the mnemonic for integrity/reference checking. Everstake's most-starred public repo (24 stars).

## What it does technically
- Go module `bip39` (Go 1.23), CLI built with `urfave/cli/v2`, wraps `tyler-smith/go-bip39` for the actual BIP39 implementation, adds Argon2id hashing (`golang.org/x/crypto`).
- Two subcommands: `bip39 generate` (word count configurable, default 24; colorized first/last word; optional save to file) and `bip39 existing` (verify/hash an existing mnemonic).
- Saved files use naming pattern `<Argon2idHash>_<TimestampUnixNano>.bip39`, default directory `~/bip39/mnemonics`.
- CI is unusually mature for a small tool: GitHub Actions for golangci-lint, CodeQL, gosec, a Go build workflow, and goreleaser, plus a coverage badge and `.testcoverage.yml` threshold config, `.pre-commit-config.yaml`.

## Facts about Everstake it reveals
- Everstake ships a hardened, security-scanned open-source crypto utility under its own name/org — signals it treats even small tools with production-grade Go tooling (lint/CodeQL/gosec/goreleaser) (`.github/workflows/*` implied by badges, `.golangci.yml`, `.goreleaser.yml`).
- MIT-licensed, credits `tyler-smith/go-bip39` explicitly (README "Thanks" section) — not a from-scratch BIP39 implementation, but a wrapper adding Argon2id verification, likely for operator/validator key-generation ceremonies.

## Dates
- Created: 2023-12-14.
- Last commit: 2025-06-20 (Dependabot merge bumping `golang.org/x/crypto` to 0.37.0).
- No git tags found in the shallow clone, but `.goreleaser.yml` + a GitHub Actions "goreleaser" workflow badge imply tagged releases exist upstream (not visible via `--depth 1` clone).

## Freshness signals
- `go.mod` version pins (`golang.org/x/crypto v0.39.0`, `urfave/cli/v2 v2.27.6`) and Dependabot PR merges are the clearest freshness signal — this repo is actively kept up to date via automated dependency bumps.
- goreleaser config implies GitHub Releases carry version numbers; check `https://github.com/everstake/bip39/releases` directly for the latest tag (not visible from a shallow clone).
