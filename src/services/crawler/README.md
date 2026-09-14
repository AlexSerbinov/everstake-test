# Collect public pages

Start at `crawlSource()` in [crawl-source.ts](crawl-source.ts). It takes one source configuration and a crawl budget, discovers URLs, fetches bounded batches, extracts each page, and removes AI-directed instructions before returning snapshots. Its report keeps accepted documents, exclusions, outside-host candidates and pending URLs separate. It records crawl events in SQLite; index activation happens later.

Read the helpers in this order:

1. [discover.ts](discover.ts) reads sitemap and sitemap-index URLs. The crawler adds links from accepted pages too, within the configured host, path and depth limits.
2. [fetch.ts](fetch.ts) owns network access. `safeFetch()` checks robots before each page or redirect. Its supporting helpers handle robots caching, retries and request spacing; the transport connects to a checked public IP and limits both compressed and decoded bytes. Redirects stay on the same origin.
3. [extract.ts](extract.ts) turns HTML or Markdown into text and page metadata. `readPageDates()` selects dated evidence; `preserveTextStructure()` keeps headings, table columns and link targets readable. `extractDocument()` attaches source identity and fetch details.
4. Back in [crawl-source.ts](crawl-source.ts), `sanitizeSnapshot()` strips instructions and recomputes IDs from the safe text. Removed text stays in audit metadata, outside the model-visible fields.

Page dates and fetch time mean different things. Missing page dates remain missing; sitemap hints and HTTP headers do not become publication dates. Dates more than one day after collection are rejected. HTML cleanup can remove obvious hidden text, but it cannot evaluate external stylesheets; the evidence sanitizer is still required.

[crawl-source.test.ts](crawl-source.test.ts) covers seed, sitemap and link discovery, outside-host reporting and recorded crawl outcomes. [fetch.test.ts](fetch.test.ts) covers robots, redirects and private-network rejection. [extract.test.ts](extract.test.ts) covers dates and readable extraction. These tests use controlled responses, so they need neither a live crawl nor paid API calls.
