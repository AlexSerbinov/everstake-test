---
repo: eth2-batch-deposit-contract
url: https://github.com/everstake/eth2-batch-deposit-contract
language: Solidity
stars: 0
created: 2025-10-31
last_commit: 2026-05-08
license: BSD-3-Clause-1
topics: []
---

## What it is
A Solidity smart contract, `BatchDepositConsolidation`, that lets one submit many Ethereum 2.0 validator deposits to the official ETH2 `DepositContract` in a single transaction instead of one-per-deposit, cutting gas overhead when onboarding many validators.

## What it does technically
- `contracts/ETH2BatchDepositConsolidation.sol` (Solidity 0.8.30, license BSD-3-Clause-1): constructor takes the official `IDepositContract` address; `batchDeposit(validUntil, withdrawAddress, withdrawType, values[], args)` decodes a packed `args` blob into fixed-size chunks (48-byte pubkey + 96-byte signature + 32-byte deposit-data-root per validator = 176 bytes) and loops, calling `depositContract.deposit{value: values[j]}(...)` for each, building a consolidated withdrawal-credentials byte string from a single `withdrawAddress`/`withdrawType`.
- Enforces a deadline (`validUntil`), that `args.length` is a multiple of the per-deposit size, non-zero withdraw address, matching counts between `values` and decoded deposits, and that `msg.value` equals the sum of individual `values`.
- Test harness uses Hardhat 3 (`hardhat.config.ts`), `hardhat-toolbox-viem`, `viem`, plus a `contracts/test/DepositContract.sol` mock of the real deposit contract and `contracts/interfaces/IDepositContract.sol`.
- Test command supports both Solidity-native and Node-based Hardhat tests (`npx hardhat test solidity` / `nodejs`).

## Facts about Everstake it reveals
- Everstake builds and maintains its own Ethereum validator-onboarding tooling at the smart-contract level (batch deposits) rather than relying solely on third-party staking-as-a-service contracts — consistent with running its own large-scale Ethereum validator set.
- `withdrawType` as a `bytes1` parameter suggests support for multiple withdrawal-credential prefixes (e.g. `0x01` execution-layer vs `0x02` compounding/consolidation credentials per EIP-7251/Pectra), matching the filename "Consolidation" — implying awareness of the 2025-era Ethereum staking upgrades (max-effective-balance / consolidation).
- Uses `forge-std` (Foundry) as a dev dependency alongside Hardhat — dual-tooling in the test setup.

## Dates
- Created: 2025-10-31.
- Last commit: 2026-05-08 (PR "fix/DEV-2791/updateDependencies") — note the internal Jira-style ticket ID `DEV-2791` visible in the commit/PR name, confirming this is tracked in Everstake's internal issue tracker.
- No tags/releases; License file dated "© 2025".

## Freshness signals
`package.json` devDependency versions (hardhat ^3.0.12, hardhat-toolbox-viem ^5.0.1) and the presence of Dependabot-style "updateDependencies" PRs are the main freshness signal. No CHANGELOG or semantic version in `package.json` beyond the fixed `1.0.0`.
