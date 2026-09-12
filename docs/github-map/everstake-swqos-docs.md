---
repo: everstake-swqos-docs
url: https://github.com/everstake/everstake-swqos-docs
language: Rust
stars: 3
created: 2025-10-09
last_commit: 2026-07-27
license: none found
topics: []
---

## What it is
Documentation-plus-runnable-examples repo for **"Everstake Landing"**, an ultra-low-latency Solana transaction relay/submission service (formerly branded "SWQoS" — Solana Stake-Weighted Quality of Service — the rename is recorded in the last commit message: "Rename SWQoS to Landing and document tip-based priority inclusion").

## What it does technically
- Two Rust binaries (`src/bin/rpc.rs`, `src/bin/quic.rs`) built with `cargo run --bin rpc` / `--bin quic`, using `solana-client`/`solana-sdk` 3.0, `quinn` 0.11 (QUIC), `rustls`, `tokio`.
- **RPC path**: standard Solana JSON-RPC `sendTransaction`, no API key, no preflight simulation, 10 TPS/client rate limit; requires a tip instruction (`SystemProgram::transfer` to a Tip Payment Account) or the tx is dropped.
- **QUIC path**: direct low-latency QUIC stream to a relay; requires the client pubkey to be pre-authorized/whitelisted; connection rate-limited to 8 QUIC connections/minute; 10s keep-alive; requires an RPC node flag `--rpc-send-transaction-tpu-peer <SocketAddr>` (and `--use-connection-cache` on Solana RPC 2.3+).
- Multi-path fanout: transactions are submitted simultaneously across QUIC, Jito, Harmonic, Rakurai "and etc." pathways to maximize landing probability (README.md).

## Facts about Everstake it reveals
- Everstake operates a Solana transaction-landing/relay service (product name **"Everstake Landing"**) — a distinct, discoverable product not obviously named "SWQoS" any more, live endpoints in six regions: Main (Cloudflare), FRA, NY, TYO, AMS, SGP, LON (`RESOURCES.md`).
- Minimum required tip: **1,000,000 lamports (0.001 SOL)** (`RESOURCES.md`, `LANDING-QUICKSTART.md`).
- 10 named Tip Payment Account pubkeys published (`RESOURCES.md`), e.g. `J4cL8c22KNLHwheuWxK1SCYBWASWPGhEi6xvcGyf6o3S`.
- No-tip path exists only for "prepaid subscription customers" — implies a paid-tier product alongside the free tip-based path (README.md).
- Cross-reference: separate live docs at `docs.blockspace.everstake.one/swqos/quickstart` — "Blockspace" appears to be the internal/product name for this service, with "SWQoS"/"Landing" as the externally visible branding.

## Dates
- Created: 2025-10-09.
- Last commit: 2026-07-27 ("Rename SWQoS to Landing and document tip-based priority inclusion", PR #21) — active, recently renamed product.
- No tags/releases.

## Freshness signals
Cargo.toml pins exact-ish versions of `solana-client`/`solana-sdk` (3.0.0/3.1.5) — a version bump there tracks Solana SDK compatibility. The README/RESOURCES.md endpoint list and tip amount are the parts most likely to change and worth re-checking on each refresh; the branding rename (SWQoS→Landing) itself is a signal that product naming here is still in flux.
