---
repo: wallet-sdk
url: https://github.com/everstake/wallet-sdk
language: TypeScript
stars: 5
created: 2022-11-28
last_commit: 2026-09-09
license: BSD-3-Clause
topics: [blockchain, sdk]
---

## What it is
Everstake's main developer-facing product: a TypeScript monorepo of per-chain wallet/staking SDKs (`@everstake/wallet-sdk-<chain>`) that let third-party wallets/dapps build staking flows against Everstake validators, plus a companion public REST API (Swagger at `wallet-sdk-api.everstake.com`).

## What it does technically
- Monorepo of **11 independently published npm packages** (per `CODEBASE.md`): the root deprecated `@everstake/wallet-sdk` (now just re-exports shared API helpers `CheckToken`/`SetStats`/`CreateToken`/`GetAssets`), plus `ethereum`, `polygon`, `berrachain`, `solana_v1` (`@everstake/wallet-sdk-solana`, legacy `@solana/web3.js`), `solana_v2` (`@everstake/wallet-sdk-solana-v2`, `@solana/kit`), `cardano`, `aptos`, `sui`, `hysp` (EVM vault), `hysp_solana` (Solana vault).
- Every chain package exports one class extending a shared `Blockchain` base (`utils/index.ts`), with a consistent internal layout: `<chain>.ts`, `constants/index.ts` (contract/program addresses, network configs), `constants/errors.ts`, `types/index.ts`, `__tests__/`, `__fixtures__/`. Two error-handling primitives: `throwError()` for pre-condition failures, `handleError()` for wrapping caught errors and mapping known upstream error strings.
- Tooling: pnpm workspace, TypeScript ^5.5, tsup (dual CJS/ESM + `.d.ts`) build, Jest/ts-jest, ESLint 9 + typescript-eslint + Prettier. `CODEBASE.md` and `CLAUDE.md` in the repo root are explicit "ground truth" conventions docs written for AI coding agents.
- `HYSP` is a tokenized yield/vault product: `hysp/src/constants/index.ts` hard-codes on-chain addresses for `eth_mainnet` and `base` networks — issuance vault, redemption vault, oracle, token, LP, USDC, and a `tBillAddress`/`tBillDataFeed` (T-Bill price oracle), i.e. a tokenized US Treasury-bill-backed yield vault deployed on Ethereum mainnet and Base.

## Facts about Everstake it reveals
- Chains with **active, versioned SDK code** today: Ethereum (v1.1.4), Polygon (v1.1.6), Berachain (v0.1.6 — youngest/least mature), Cardano (v1.1.7), Aptos (v1.2.6), Sui (v1.0.3), Solana legacy (v1.0.7) and Solana v2/kit (v2.1.6), HYSP EVM (v1.5.1) and HYSP Solana (v1.5.1) — all pulled from each package's `package.json` (`wallet-sdk/*/package.json`).
- The original root `@everstake/wallet-sdk` package (v1.1.1) is explicitly **deprecated for chain functionality** — it used to bundle a Solana implementation directly, now removed in favor of `wallet-sdk-solana` (`wallet-sdk/README.md`).
- HYSP vault contract addresses are live and specific, e.g. mainnet `tokenAddress: 0x548857309BEfb6Fb6F20a9C5A56c9023D892785B`, Base `tokenAddress: 0xccbad2823328BCcAEa6476Df3Aa529316aB7474A` (`hysp/src/constants/index.ts`) — real deployed contracts, not placeholders.
- EVM chains (ETH/Polygon/Berachain) use `web3` v4; Hysp uses `ethers` v6; Solana v2/Hysp-Solana use `@solana/kit` v3 — three different Web3 libraries coexist by design (`CODEBASE.md` tech-stack table).
- Latest commit (2026-09-09, PR #150) is titled "replace .one to .com for everstake sources" — active migration of the legacy `everstake.one` domain to `everstake.com` across the codebase, matching the same domain shift visible in the `mcp` repo.

## Dates
- Created: 2022-11-28.
- Last commit: 2026-09-09 (PR #150, domain migration) — the most recently active repo in the entire org.
- No git tags in the shallow clone; each sub-package's own `package.json` version is the de facto release marker (published independently to npm).

## Freshness signals
- Each chain directory's `package.json` `version` field is the strongest signal — check it against the published npm package to see if a release has shipped.
- `CODEBASE.md`'s package-map table would need updating if a chain is added/removed/renamed; treat any diff there as a structural change.
- No CHANGELOG.md was found; rely on commit messages / PR titles (many carry Jira-style prefixes) and npm version bumps.
