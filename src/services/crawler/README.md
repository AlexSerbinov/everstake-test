# Crawler

Collects public HTML and Markdown into dated document snapshots.
Start with `crawl-source.ts`; discovery, safe fetching, and extraction are separate adjacent files.
Input is one `SourceConfig` plus explicit hosts, paths, budgets, and progress callbacks.
Output includes accepted documents, exclusions, outside-host candidates, pending URLs, and counts.
Every request checks robots policy and public DNS, and redirects stay within the origin.
Page dates remain distinct from fetch time and sitemap hints are not used as publication dates.
Tests cover robots, redirects, SSRF rejection, sitemap/link discovery, dates, and structure.
