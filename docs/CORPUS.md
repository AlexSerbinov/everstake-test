# Corpus report

This report describes the frozen web corpus produced on 2026-09-13. The source of record is [`artifacts/corpus/707fca2a-2f0f-421b-bfc5-e3c2daabb8e9.json`](../artifacts/corpus/707fca2a-2f0f-421b-bfc5-e3c2daabb8e9.json), with the activated rows in `data/knowledge.sqlite`. Counts below are measurements from that run, not projections.

## Frozen run

| Measure | Result |
|---|---:|
| Configured source groups | 29 |
| Seeds | 58 |
| Same-origin URLs discovered and admitted to the crawl queue | 998 |
| URLs fetched | 972 |
| Accepted URL results | 970 |
| Active unique document snapshots | 935 |
| Canonical representatives | 923 |
| Search chunks | 7,638 |
| Exclusion events | 32 |
| Bytes downloaded | 298,974,834 (299.0 MB) |
| Wall time | 348,046 ms (5m 48s) |
| Paid API calls during crawl and local indexing | 0 |

Thirty-five accepted URL results collapsed into an existing stable document identity, mainly aliases within `everstake.com`, which explains the difference between 970 accepted results and 935 stored snapshots. Twenty source groups contributed documents; nine contributed none. The activated corpus version is `corpus-b3ab09e66f53`.

## Coverage

| Kind | Documents | Composition |
|---|---:|---|
| Website | 736 | 733 `everstake.com` pages and 3 `blockspace.everstake.com` pages |
| Documentation | 180 | 147 Everstake docs, 31 Blockspace docs, and 2 Ethereum docs |
| News | 15 | 2 Medium pages and 13 single-page external publications |
| GitHub | 4 | Bounded Markdown documents from the configured Everstake repository seeds |
| **Total** | **935** | **29 configured groups, 20 with accepted material** |

The crawler starts only from operator-configured roots and seed URLs in [`assistant/config/sources.yaml`](../assistant/config/sources.yaml). It expands through sitemaps and same-origin links when enabled. The crawl found 9,391 occurrences of external links, representing 3,581 unique URLs, but recorded them as candidates rather than silently expanding the trust boundary. Adding one requires an explicit source entry, authority tier, reason, and crawl policy.

These 935 documents are the web-only measurement. The four accepted video transcripts were added in the final integration described below; the frozen corpus therefore has 939 documents.

## Exclusions

Every rejected fetch is retained with a machine-readable reason. The 32 events were: 13 `cross_origin_redirect`, 6 `http_error`, 4 `oversized_response`, 4 `sitemap_failure`, 2 `insufficient_content`, 2 `robots_disallowed`, and 1 `robots_unavailable`.

The crawler uses an identified user agent and per-host throttling, parses `robots.txt`, and fails closed when robots policy cannot be established; a 404 or 410 robots response means no policy was published. DNS is resolved and pinned to public addresses before requests, private and local ranges are rejected, responses have byte and time limits, retries are bounded, and redirects must remain on the original origin. This conservative redirect rule excluded legacy `.one` and status URLs that moved to another host even when the destination appeared related. Much of the migrated Everstake content was independently collected from the configured `everstake.com` group.

The nine zero-document groups were legacy `everstake.one`, `blockspace.everstake.one`, `security.everstake.com`, `status.everstake.one`, `stake.everstake.com`, Smithery, X, LinkedIn, and Crunchbase. Their observed causes were cross-origin migration, unavailable or disallowing robots policy, HTTP 403, or insufficient server-rendered text. The system did not bypass those controls. A targeted refresh that fails or finds no accepted replacement leaves the previously active source snapshot in place; a confirmed 404 or 410 can retire a page.

## Dates and freshness

Publication and observation time are separate fields. HTML JSON-LD and article metadata supplied a publication date for 678 documents: 673 through JSON-LD `datePublished` and 5 through article metadata. Three further documents had only a page-supplied modification date. The remaining 254 documents, 27.2% of the corpus, have neither a page publication nor update date and therefore use crawl time only as `fetchedAt` observation metadata.

HTTP `Last-Modified`, sitemap `lastmod`, and `fetchedAt` are not promoted to publication dates. Undated evidence receives a lower temporal component in trust scoring, and answers expose an evidence date rather than presenting crawl time as the date a fact became true. This preserves the distinction between “published on” and “observed on,” but it cannot recover dates publishers omitted.

## Duplicates, revisions, and sanitization

Stable document IDs combine canonical URL and sanitized content hash, so a changed page becomes a retained revision rather than overwriting history. URL aliases with the same identity are merged as aliases. Across URLs, exact content hashes and five-word-shingle Jaccard similarity at a 0.88 threshold produced 6 duplicate groups containing 18 documents: 5 exact groups and 1 near-duplicate group. That is 12 additional copies beyond the group representatives. Near-duplicate grouping is refused when numeric token signatures differ, and revisions of the same canonical URL are not treated as independent corroboration.

Exact copies contribute chunks only through their selected representative. Near duplicates remain searchable because small textual changes may carry changed facts, while retrieval limits repeated passages from one duplicate group. Representatives are selected by source authority, then page date, then URL. Duplicate frequency therefore does not become evidence of truth, and original snapshots remain inspectable.

Before hashing, chunking, or indexing, the sanitizer removed 7 sentences addressed to AI systems from 6 active documents and retained only removal counts and matched rule names in audit metadata. Those fields are excluded from answer-visible metadata. This is a rule-based English-language control: it covers the tested imperative patterns but may require new rules for other languages or novel phrasing. This sentence describes the frozen run above; the [current sanitizer](../src/services/evidence/sanitize-document.ts) also contains Ukrainian, Russian, German and Spanish patterns. Their presence does not establish measured coverage of every attack or language.

## Known limits

The corpus is broad within its configured boundary, not a complete archive of every Everstake mention. JavaScript-only pages may yield too little server-rendered text; cross-origin moves require an operator decision; 254 documents are undated; GitHub coverage is deliberately bounded; video remains a separate pilot; and near-duplicate detection can miss paraphrases below its threshold. The frozen artifact records what was actually attempted and excluded so those gaps are visible rather than counted as successful coverage.

## Final frozen corpus after integration

The initial web run above is preserved as its own measurement. Final integration added four accepted YouTube transcripts, re-sanitized the AI guidance page, retained all near-duplicate variants, and exercised a staged targeted refresh. The final [manifest](../artifacts/corpus/frozen-manifest.json) identifies `corpus-eae2b2b23116`: **939 active documents, 927 canonical content groups, 7,694 active chunks**. Six duplicate groups contain seven redundant exact copies plus five additional near-duplicate members. Only the exact copies collapse at indexing; near-duplicate variants remain searchable. The source dates and final sanitation checks were independently re-audited in [evaluation-reference-audit.md](evaluation-reference-audit.md).
