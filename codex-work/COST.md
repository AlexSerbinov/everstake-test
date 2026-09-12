# Measured Cost & Resources

Building the measured index pipeline cost **$0.015503**. Across 4 measured full-agent questions, one question averaged **$0.005096**.

Prices were copied on **2026-09-12**. Tokens are provider-reported; wall time, process CPU and peak RSS are captured during the run.

## Per-stage measurements

| Stage | Runs as | Model | Units | Download | Tokens in / out (cache) | USD | Wall | CPU | Peak RAM | Machine | $ / unit |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Polite crawl | code | — | 280 documents | 95.08 MB | 0 / 0 (0) | $0.00000000 | 3.91m | 6.39s | 61.67 MB | MacBook Pro (local development) | $0.0000000000 |
| Deduplication | code | — | 280 documents | 0 B | 0 / 0 (0) | $0.00000000 | 3.59s | 3.58s | 84.83 MB | MacBook Pro (local development) | $0.0000000000 |
| Clean, chunk & index | code | — | 1,072 chunks | 0 B | 0 / 0 (0) | $0.00000000 | 854.0ms | 818.9ms | 84.83 MB | MacBook Pro (local development) | $0.0000000000 |
| Fact-ledger extraction | code | — | 1,072 chunks scanned | 0 B | 0 / 0 (0) | $0.00000000 | 11.5ms | 11.4ms | 84.83 MB | MacBook Pro (local development) | $0.0000000000 |
| Index embeddings | model | text-embedding-3-small | 1,072 chunks | 0 B | 775,151 / 0 (0) | $0.01550302 | 43.79s | 441.7ms | 84.83 MB | MacBook Pro (local development) | $0.0000144618 |
| Quality evaluation | model + code | text-embedding-3-small, gemini-3.8-flash | 20 questions | 0 B | 118,844 / 2,285 (0) | $0.09753750 | 32.04s | 1.64s | 48.09 MB | MacBook Pro (local development) | $0.0048768750 |
| Adversarial evaluation | model + code | gemini-3.8-flash, text-embedding-3-small | 20 questions | 0 B | 22,886 / 865 (0) | $0.02038270 | 12.08s | 433.7ms | 59.77 MB | MacBook Pro (local development) | $0.0010191350 |

## One real question, step by step

**Question:** How has Everstake's positioning shifted since 2024?

| Step | Tool or model | Tokens in / out (cache) | USD | Time |
|---|---|---:|---:|---:|
| Model turn | gemini-3.8-flash | 1,143 / 33 (0) | $0.00098100 | 693.2ms |
| query_embedding | text-embedding-3-small | 23 / 0 (0) | $0.00000046 | 207.1ms |
| Searching and ranking the corpus | code | 0 / 0 (0) | $0.00000000 | 277.4ms |
| Model turn | gemini-3.8-flash | 5,658 / 421 (0) | $0.00582225 | 2.42s |
| **Total** |  | **6,824 / 454 (0)** | **$0.00680371** | **3.40s** |

Measured on **MacBook Pro (local development)**.

## ×50, row by row

| Stage | Measured USD | ×50 USD | Serial wall-time arithmetic |
|---|---:|---:|---:|
| Polite crawl | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 3.91m × 50 = **195.34m** |
| Deduplication | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 3.59s × 50 = **2.99m** |
| Clean, chunk & index | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 854.0ms × 50 = **42.70s** |
| Fact-ledger extraction | $0.00000000 | $0.00000000 × 50 = **$0.00000000** | 11.5ms × 50 = **572.8ms** |
| Index embeddings | $0.01550302 | $0.01550302 × 50 = **$0.77515100** | 43.79s × 50 = **36.49m** |
| Quality evaluation | $0.09753750 | $0.09753750 × 50 = **$4.87687500** | 32.04s × 50 = **26.70m** |
| Adversarial evaluation | $0.02038270 | $0.02038270 × 50 = **$1.01913500** | 12.08s × 50 = **10.07m** |
| One full-agent question | $0.00680371 | $0.00680371 × 50 = **$0.34018550** | 3.40s × 50 = **2.83m** |

## Spend ledger

Before this task, **397** local provider events totalled **$0.25609992**. Their provider token/cost fields remain in the append-only paid-call ledger; wall time, CPU and RAM were never captured and are therefore not reconstructed.

This task used **$0.30510199** across local and deployed checks. The complete known assignment spend is **$0.56476151**.

## What is measured vs assumed

- Provider list prices copied 2026-09-12; later prices may differ.
- Provider usage fields are measured; no tokenizer estimates are used.
- ×50 time is serial multiplication, not a parallel-throughput forecast.
- CPU and RSS depend on the recorded machine and cannot be transferred to other hardware.
- Historical runs without resource telemetry are excluded from current stage timing.

**Where the money goes:** 100% of index cost is index embeddings; 83% of measured index time is polite crawl.
