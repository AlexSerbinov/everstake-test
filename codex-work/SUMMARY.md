# Submission Summary

## What I built

A public-corpus Everstake knowledge assistant with factual and synthesis modes, evidence dates, clickable citations, explicit source/recency policy, exact and near deduplication, repeated-template filtering, ingestion-time instruction screening, deterministic output validation, and honest abstention. The repository includes source code, a 280-document corpus, a ready-to-run SQLite index, agents, skills, prompts, tests, measured artifacts, Docker packaging, and all requested written deliverables. `PROCESS.md` is intentionally a one-line placeholder because Part B was explicitly excluded.

## Live deployment

**https://everstake-codex.89-167-19-222.sslip.io**

Verified on 11 September 2026:

- public homepage: HTTP 200 over TLS;
- public health endpoint: HTTP 200;
- public factual query: HTTP 200 with current CEO, date, and canonical citations;
- browser negative query: exact corpus-bounded abstention;
- container: running with zero restarts, bound only to `127.0.0.1:4321` behind Caddy;
- persistent state: `/data/everstake-codex/state/`.

## Measured results

- 280 fetched documents; 270 unique duplicate groups; 1,075 indexed chunks.
- 10 duplicate documents; 10 exact and 2 near-duplicate pairs detected.
- 16 repeated template signatures removed across 1,232 line occurrences.
- 3 documents contained instruction-like sentences removed before indexing.
- Final evaluation: 20/20 passed, including 5/5 negative cases; 0 invented facts.
- Final index: 776,291 API-reported tokens; $0.01552582.
- Mean measured query: $0.00063698; all assignment API activity: $0.13266996.
- 50× index projection: 38,814,550 tokens and $0.776291.

## What I cut

Video transcription, PDF/OCR ingestion, production ANN storage, authentication/rate limiting, multilingual evaluation, and a human review console. These cuts protected the time budget for recency/conflict handling, measured evaluation, safety boundaries, and a working deployment.

## Defence notes

Lead with the stale-CEO failure: semantic similarity initially preferred the June 2025 announcement over the newer canonical state, which is why mutable facts now have explicit source contracts outside the prompt. Then show the corpus issue the brief did not name: repeated fragments inside unique pages polluted retrieval more than whole-page duplicates; removing them cut index tokens by 9.24%. Be candid that 20/20 is a regression-contract result, not estimated unseen accuracy. For a live change, the clearest extension points are `source_authority`, `adjudicate_evidence`, the `0.16` abstention threshold, and the `ANSWER_PROMPT` in `app/retrieval.py`.
