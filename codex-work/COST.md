# Measured Cost & Resources

Building the measured index pipeline cost **$0.017469**. Across 4 measured full-agent questions, one question averaged **$0.005937**.

Prices were copied on **2026-09-12**. Tokens are provider-reported; wall time, process CPU and peak RSS are captured during the run.

## Per-stage measurements

| Stage | Runs as | Model | Units | Download | Tokens in / out (cache) | USD | Wall | CPU | Peak RAM | Machine | $ / unit |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Polite crawl | code | — | 280 documents | 95.08 MB | 0 / 0 (0) | $0.00000000 | 3.91m | 6.39s | 61.67 MB | MacBook Pro (local development) | $0.0000000000 |
| Deduplication | code | — | 304 documents | 0 B | 0 / 0 (0) | $0.00000000 | 5.27s | 4.89s | 90.02 MB | Darwin arm64 (Alexs-MacBook-Pro.local) | $0.0000000000 |
| Clean, chunk & index | code | — | 1,223 chunks | 0 B | 0 / 0 (0) | $0.00000000 | 1.05s | 969.6ms | 90.02 MB | Darwin arm64 (Alexs-MacBook-Pro.local) | $0.0000000000 |
| Fact-ledger extraction | code | — | 1,223 chunks scanned | 0 B | 0 / 0 (0) | $0.00000000 | 12.9ms | 12.8ms | 90.02 MB | Darwin arm64 (Alexs-MacBook-Pro.local) | $0.0000000000 |
| Index embeddings | model | text-embedding-3-small | 1,223 chunks | 0 B | 873,426 / 0 (0) | $0.01746852 | 11.90s | 348.5ms | 90.02 MB | Darwin arm64 (Alexs-MacBook-Pro.local) | $0.0000142833 |
| Quality evaluation | model + code | text-embedding-3-small, gemini-3.8-flash | 20 questions | 0 B | 118,531 / 2,495 (0) | $0.09809025 | 48.64s | 1.78s | 49.91 MB | Darwin arm64 (Alexs-MacBook-Pro.local) | $0.0049045125 |
| Adversarial evaluation | model + code | gemini-3.8-flash, text-embedding-3-small | 24 questions | 0 B | 26,222 / 1,096 (0) | $0.02374949 | 18.83s | 500.4ms | 64.14 MB | Darwin arm64 (Alexs-MacBook-Pro.local) | $0.0009895621 |

## One real question, step by step

**Question:** How has Everstake's positioning shifted since 2024?

| Step | Tool or model | Tokens in / out (cache) | USD | Time |
|---|---|---:|---:|---:|
| Model turn | gemini-3.8-flash | 1,381 / 40 (0) | $0.00118575 | 879.8ms |
| query_embedding | text-embedding-3-small | 28 / 0 (0) | $0.00000056 | 223.9ms |
| Searching and ranking the corpus | code | 0 / 0 (0) | $0.00000000 | 333.9ms |
| Model turn | gemini-3.8-flash | 6,330 / 454 (0) | $0.00645000 | 5.39s |
| Computing deterministic Trust Score | code | 0 / 0 (0) | $0.00000000 | 0.0ms |
| **Total** |  | **7,739 / 494 (0)** | **$0.00763631** | **6.62s** |

Measured on **Darwin arm64 (Alexs-MacBook-Pro.local)**.

## ×50, row by row

| Stage | Measured USD | ×50 USD | Serial wall-time arithmetic |
|---|---:|---:|---:|
| Polite crawl | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 3.91m × 50 = **195.34m** |
| Deduplication | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 5.27s × 50 = **4.39m** |
| Clean, chunk & index | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 1.05s × 50 = **52.51s** |
| Fact-ledger extraction | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 12.9ms × 50 = **643.5ms** |
| Index embeddings | $0.01746852 | $0.01746852 × 50 = **$0.87342600** | 11.90s × 50 = **9.92m** |
| Quality evaluation | $0.09809025 | $0.09809025 × 50 = **$4.90451250** | 48.64s × 50 = **40.53m** |
| Adversarial evaluation | $0.02374949 | $0.02374949 × 50 = **$1.18747450** | 18.83s × 50 = **15.69m** |
| One full-agent question | $0.00763631 | $0.00763631 × 50 = **$0.38181550** | 6.62s × 50 = **5.52m** |

## Spend ledger

Before this task, **397** local provider events totalled **$0.25609992**. Their provider token/cost fields remain in the append-only paid-call ledger; wall time, CPU and RAM were never captured and are therefore not reconstructed.

This task used **$0.61509563** across local and deployed checks. The complete known assignment spend is **$0.87475515**.

## What is measured vs assumed

- Provider list prices copied 2026-09-12; later prices may differ.
- Provider usage fields are measured; no tokenizer estimates are used.
- ×50 time is serial multiplication, not a parallel-throughput forecast.
- CPU and RSS depend on the recorded machine and cannot be transferred to other hardware.
- Historical runs without resource telemetry are excluded from current stage timing.

**Where the money goes:** 100% of index cost is index embeddings; 93% of measured index time is polite crawl.
