# Technical and Product Report

## Architecture

The system is a deliberately small pipeline: **seed + publisher sitemaps → polite fetch → normalized documents → safety and boilerplate filtering → duplicate groups → chunks and embeddings → hybrid retrieval → source adjudication → grounded answer**. The submitted corpus contains 280 successfully fetched public documents, exceeding the 200-document requirement. It produced 1,075 retrievable chunks in 270 unique document groups.

The crawler starts with the supplied 60-ish URLs and expands only through publisher-declared sitemaps on `everstake.com` and `docs.everstake.com`. That choice grows coverage without an unconstrained link spider. Every request uses an identifying User-Agent, consults `robots.txt`, rate-limits per host, caps response size, and uses a host allowlist. If robots policy cannot be established, the crawler fails closed. `data/crawl-audit.json` records nine exclusions in the final crawl, including robots/fetch failures, unsupported thin JavaScript pages, and social hosts deliberately outside the allowlist.

Video is represented as a category but not transcribed. The three YouTube watch pages were retained as provenance, but transcript acquisition was cut: two interviews are old, one is third-party comparison content, and the likely incremental factual value did not justify transcript processing within the timebox. A month-long version would transcribe only videos whose title/date/description indicate unique first-party statements, then evaluate whether they improve held-out questions.

At indexing time, HTML is reduced to main/article text while publication and modification dates are read from JSON-LD first. The indexer removes repeated template lines, screens instruction-like sentences, groups exact and near duplicates, chunks sanitized text with overlap, calls `text-embedding-3-small`, and stores everything in SQLite. FTS5 provides lexical matching; 512-dimensional embeddings provide semantic recall. Retrieval combines both signals, then applies source authority and recency. A fixed top-k context keeps query cost approximately independent of corpus size.

Generation uses `gemini-2.5-flash-lite` at temperature 0.1 with JSON output. It is not allowed to answer from model memory. Application code rejects low-confidence retrieval before generation, verifies citation IDs, requires at least two documents for synthesis, fills a missing evidence date deterministically, and converts unsupported output to the exact abstention sentence.

## Recency, authority, and contradictions

Popularity is not authority. Each document has a source tier, and canonical-purpose pages receive higher weights than blog posts and syndicated third-party copies. Date decay is used for factual lookup but disabled for synthesis so older trajectory evidence remains discoverable. Mutable company facts also use explicit source contracts. Current leadership, for example, is adjudicated using `/ai-info` and `/company/about`; the June 2025 “David Kinitsky joins as CEO” announcement is valid history but cannot override the newer canonical state. Likewise, an MCP endpoint question uses the canonical AI/product pages rather than repeated news boilerplate.

This is intentionally visible policy code, not an instruction to “prefer recent sources” that a model may ignore. If equally current and authoritative sources conflict, the safe product behavior is abstention. Dates refer to `dateModified`, then `datePublished`, then crawl date when the page exposes neither; the UI labels the evidence date rather than pretending crawl time is publication time.

## Deduplication and the corpus problem not stated in the brief

Normalized exact hashes and 64-bit five-token SimHash identify duplicates. A pair is near-duplicate only when length is similar and SimHash/title constraints agree. The final run found 10 duplicate documents across 12 exact/near duplicate pairs, leaving 270 unique groups. One canonical winner per group is searchable; duplicates remain stored for audit.

The more damaging issue was not whole-page duplication: it was **template-content multiplication inside otherwise unique pages**. Related-article excerpts, newsletter text, company boilerplate, and legal disclaimers appeared across many pages. They made irrelevant recent articles look semantically relevant to almost every company question and caused dates from unrelated pages to dominate. A document-level deduper cannot solve this. The indexer therefore counts long normalized lines once per document and removes signatures present in at least 8% of the corpus. The measured final run removed 16 signatures across 1,232 line occurrences and reduced index input from 855,358 to 776,291 tokens (79,067 tokens, 9.24%). This improved precision and reduced cost without deleting source-specific body text.

## Instructions embedded in documents

This is handled before retrieval, not solely by a prompt. Web pages are an untrusted data plane. `app/security.py` detects direct model/assistant instructions at sentence granularity; three documents contained instruction-like material in the final run. Matching sentences are omitted before chunking and embedding, while samples and counts remain in SQLite for audit. Sentence granularity matters: one canonical block can contain a valid fact followed by an instruction, so quarantining the whole page would discard good evidence. The generation prompt adds a second boundary by marking evidence as quoted data, but that is defense in depth rather than the primary control. In a production version I would replace regex-only detection with a versioned classifier plus an analyst review queue, test it against indirect injection, and retain cryptographic raw snapshots outside the serving path.

## Evaluation

The frozen final run passed 20/20 declared cases: 15 positive and five negative; failures 0; invented facts 0. Full questions, reference answers, outputs, dates, links, and verdicts are in `EVAL.md` and the machine-readable `data/eval-results.json`. The negative contract requires exact abstention. Positive verdicts require expected facts, a date, and a citation.

This result is not a claim of 100% general accuracy. It is a small deterministic regression set, and term matching is weaker than independent expert adjudication. During development it caught a stale-CEO answer, missing output dates, incomplete legal-entity retrieval, and the `.com` versus `.one` MCP endpoint conflict. Those failures led to code changes before the final frozen run. With one month, I would create a larger time-split set written by a second person, include adversarial contradictions/injections and citation-entailment scoring, and report confidence calibration by question class.

## Measured cost

The final index build used **776,291 input tokens** reported by the OpenAI API. At **$0.02 per million tokens**, its actual list-price cost was **$0.01552582**. The final 20-query evaluation used 118,844 input tokens and 2,183 output tokens across embedding and generation. Mean measured query cost was **$0.00063698** (median $0.00062887; range $0.00032972–$0.00115684). Prices used are the published rates for [`text-embedding-3-small`](https://developers.openai.com/api/docs/models/text-embedding-3-small) ($0.02/M input tokens) and [Gemini 2.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/pricing) ($0.10/M input, $0.40/M output).

For a 50× corpus, assuming the same content mix and linear embedding volume: `776,291 × 50 = 38,814,550 tokens`; `38,814,550 / 1,000,000 × $0.02 = $0.776291` to build embeddings. SQLite size would grow roughly from 9 MB to about 450 MB. Per-query model cost should remain near the measured $0.000637 because top-k context is fixed; retrieval CPU would grow linearly in this simple implementation and should move to an approximate-nearest-neighbor index. All experimental runs, including stopped/rebuilt indexes, development/evaluation queries, and two deployed smoke queries, consumed **$0.13266996**; this higher total is disclosed separately from the final reproducible build cost.

## Baseline comparison

Compared with Everstake's MCP server, this assistant is better for dated, multi-source historical synthesis, provenance inspection, duplicate/boilerplate handling, conflict policy, and corpus-bounded abstention. It is worse for live operational facts: the MCP already exposes dynamic `get_chains`, uptime, fees/APY, and a staking calculator with a 30-minute cache, returns structured tool results with lower latency, and can submit integration requests. For current chain metrics or calculator questions, the MCP is the better product; this system adds value where evidence across public history must be reconciled and explained.

## Deliberate cuts and one-month plan

I cut video transcription, PDF/OCR extraction from research reports, a production ANN/vector database, authentication/rate limiting, multilingual query evaluation, and a human review console. These were lower value than measured retrieval correctness, recency policy, and honest abstention in the stated timebox. I also did not implement Part B because the assignment owner explicitly excluded it; `PROCESS.md` contains the requested one-line placeholder.

With one month I would add immutable raw-object storage and content-change diffs; sitemap incremental refresh with alerts; certificate/date extraction from the security portal; selective video/PDF ingestion; ANN retrieval with reranking; source-level freshness SLAs; injection red-team fixtures; a 100+ question blind evaluation maintained separately from implementation; and monitoring for crawl coverage, answer/citation drift, abstention rate, latency, and spend. I would keep the visible policy layer and small interfaces so a reviewer can still change behavior live.
