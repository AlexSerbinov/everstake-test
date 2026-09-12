# Everstake GitHub Org — Map

Source: `https://api.github.com/orgs/everstake/repos?per_page=100&type=public`, fetched 2026-09-12. 69 repos returned by the API; **15 are public, non-fork, non-archived** and covered here. The rest are forks or archived and were excluded.

| Repo | What it is | Language | Last commit | Activity |
|---|---|---|---|---|
| [wallet-sdk](wallet-sdk.md) | Monorepo of 10+ per-chain staking SDKs (ETH, Polygon, Berachain, Solana v1/v2, Cardano, Aptos, Sui, HYSP) + REST API | TypeScript | 2026-09-09 | active |
| [mcp](mcp.md) | Official Everstake MCP server — 11 tools exposing company/product/staking data to AI agents | Go | 2026-08-25 | active |
| [.github](.github.md) | Org profile README shown on github.com/everstake | Markdown | 2024-11-07* | stale (see note) |
| [chkrootkit](chkrootkit.md) | Vendored copy of the third-party chkrootkit rootkit scanner v0.58 (ops tooling, not an Everstake product) | Shell/C | 2024-04-23 | stale |
| [eigenlayer](eigenlayer.md) | EigenLayer operator metadata (mainnet withdrawal notice, testnet + Swell white-label operator profiles) | JSON | 2026-07-02 | active (content-only) |
| [everstake-swqos-docs](everstake-swqos-docs.md) | Docs + Rust examples for "Everstake Landing" (renamed from SWQoS), Solana tx relay/landing service | Rust | 2026-07-27 | active |
| [eth2-batch-deposit-contract](eth2-batch-deposit-contract.md) | Solidity contract batching many ETH2 validator deposits into one tx | Solidity | 2026-05-08 | active |
| [bip39](bip39.md) | CLI/library for BIP39 mnemonic generation + Argon2id hashing; most-starred repo (24 stars) | Go | 2025-06-20 | active (dependency bumps) |
| [gpg](gpg.md) | Instructions for encrypting vulnerability reports via GPG; publishes Everstake's PGP key | Markdown | 2024-01-19 | stale |
| [multiversx](multiversx.md) | Data file with 101 BLS validator keys for MultiversX explorer import | JSON | 2023-11-23 | stale |
| [i](i.md) | Two static image assets (bg.png, logo.svg), no README | — | 2025-03-18 | stale |
| [oasis-documentation](oasis-documentation.md) | Guides for running an Oasis Network validator + Emerald ParaTime node | Markdown | 2022-11-10 | stale |
| [eosmon](eosmon.md) | Shell scripts exporting EOS/Telos/BOS/MEETONE node metrics to Prometheus/Grafana | Shell | 2023-11-16 | stale |
| [goz-relayer-helper](goz-relayer-helper.md) | Helper script for the 2020 Cosmos "Game of Zones" IBC relayer testnet | Shell | 2023-11-16 (README-only touch) | dormant |
| [proxymon](proxymon.md) | Telegram bot alerting on low EOS proxy balance | Shell | 2019-11-20 | dormant |

\* `.github`'s `pushed_at` from the API shows 2026-09-04, but the shallow clone's visible commit history on the default branch ends 2024-11-07 — likely a metadata-only push (settings/branch protection) not reflected in file history. See `.github.md` for detail.

**Activity legend:** *active* = meaningful code/content change within the last ~12 months; *stale* = repo exists and is coherent but untouched 1+ years; *dormant* = essentially a historical snapshot of a one-off event, unlikely to change again.

## What the org tells us about the company

- **Live products with code in this org:** the Wallet SDK (multi-chain staking integration, the most actively developed repo), the Everstake MCP server (the canonical machine-readable "about Everstake" dataset — company facts, products, certifications, live chain/APY data, a staking calculator, and a sales-lead intake tool), the Solana "Landing"/SWQoS transaction-relay service (docs + examples), and an Ethereum batch-deposit smart contract for validator onboarding.
- **Networks with concrete code/config evidence:** Solana (2 SDK generations + a dedicated relay product), Ethereum (SDK + batch-deposit contract + HYSP vault), Polygon, Berachain, Cardano, Aptos, Sui (all via wallet-sdk), MultiversX (101 validator keys), Oasis Network (validator + ParaTime docs), EOS/Telos/BOS/MEETONE and Cosmos (historical, 2019-2020 tooling, dormant).
- **Dormant/abandoned:** the EOS-family and Cosmos-relayer tooling (2019-2020) is untouched for years and reads as pre-institutional-era Everstake. More notably, **`eigenlayer/metadata.json` is a live, actively-maintained repo whose content says Everstake withdrew as an EigenLayer mainnet operator** ("DO NOT STAKE... unstake or redelegate") — while it still runs a testnet operator and a white-label operator for Swell Network. This directly contradicts any assumption that EigenLayer is a current Everstake staking product.
- **In-flight rebrand:** both `wallet-sdk` (2026-09-09) and `mcp` (2026-08-25) have recent commits migrating URLs from the legacy `everstake.one` domain to `everstake.com` — an org-wide domain cutover happening now. The `gpg` and org-profile `.github` repos still reference `everstake.one` and haven't been updated to match.
- **Naming drift:** the Solana relay product is called "SWQOS" in the `mcp` server's static tool data but has been renamed "Landing" in `everstake-swqos-docs` as of July 2026 — the `mcp` repo's product copy has not caught up to that rename yet, so anyone reading `get_products` output today gets a stale product name.
- **MCP baseline location:** `github.com/everstake/mcp` — this is the authoritative source for the `get_company_profile`/`get_products`/`get_chains` etc. static and live data an AI assistant would surface about Everstake; refreshing knowledge about "what Everstake says about itself" should track `tools.yaml` in that repo specifically.
- **Ops tooling included by accident-of-inclusion:** `chkrootkit` is not an Everstake product, just a vendored security scanner; worth excluding from any "products built by Everstake" narrative even though it's a public repo under the org.
