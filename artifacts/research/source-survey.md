# Source discovery survey

Research snapshot: 2026-09-13. Counts below are discovery observations, not accepted corpus counts. The rebuilt crawler must independently record retrieval outcomes.

## W01: website, blogs, historical domains

Current live catalogs:

- `https://everstake.com/sitemap.xml` has four children and 736 URLs total now: `sitemap-main.xml` 46, `sitemap-blog.xml` 630, `sitemap-events.xml` 21, `sitemap-reports.xml` 39. This is one more blog URL than the 2026-09-11 survey (629).
- `https://docs.everstake.com/sitemap.xml` -> `sitemap-pages.xml`, 73 URLs. Pages can be requested as `<path>.md`; also use `https://docs.everstake.com/llms.txt` for discovery and `llms-full.txt` only as a completeness cross-check/duplicate aggregate, not 74 extra documents.
- `https://docs.blockspace.everstake.com/sitemap.xml`: old crawler has 31 useful dated product-manual documents. Recheck live in the new crawler.
- `https://blockspace.everstake.com/sitemap-index.xml` -> `sitemap-0.xml`, 3 URLs (root, privacy, terms).
- `https://security.everstake.com/robots.txt` explicitly allows root plus `/compliance`, `/controls`, `/resources`, `/updates`, `/trusted-by`, `/faq`, `/subprocessors`, `/your-data`, `/testimonials`, `/unsubscribe-from-trust-center-updates`; actual `/resources` returned CloudFront 403 today. Record blocked/failure rather than silently omit.
- `https://status.everstake.one/` redirects to `https://status.everstake.com/`. Treat operational status as an observed live snapshot, with `observed_at`; do not turn live uptime into a publication-dated evergreen fact.
- `https://eth-docs.everstake.one/` remains live and links at least `/guide/ethereum-b2b-api.html` and `https://swagger.eth-api.everstake.one/`; it has no real sitemap (`/sitemap.xml` resolves to an HTML app route). Link crawl is needed if this legacy documentation is accepted.
- `https://btc-staking.everstake.one/` is still listed in `everstake.com/llms.txt` but currently redirects to the generic `https://everstake.com/` homepage. Record as stale official-link evidence, not a BTC product document.
- Every tested `everstake.one` article redirects to its `everstake.com/resources/blog/...` canonical. Retain the alias/redirect chain, embed the canonical once.

Robots findings needing explicit policy/tests:

- `everstake.com/robots.txt` is internally contradictory for named AI bots: the Cloudflare block disallows GPTBot/ClaudeBot/etc., a later owner block allows several of the same bots, while the general `User-agent: *` allows `/`. The crawler should identify with its own honest UA and therefore use the unambiguous general group. Record the fetched robots hash/text for each run.
- `everstake.one/robots.txt` currently has general `Allow: /` plus named AI-bot disallows. The old config sentence “legacy domain disallows AI crawlers” is too broad/outdated for a custom UA. Seed-only remains sensible because the content redirects and would add aliases, not unique pages.
- `docs.everstake.com` is explicit `Allow: /` with `ai-input=yes`; Blockspace explicitly welcomes agents. Security has a whitelist but CloudFront still blocks in practice.
- The old `claude-work/src/crawl/robots.ts` fails open when robots fetch throws. The new `CRAWLER.md` calls for fail-closed on unknown/unavailable policy, with distinct `robots_disallow`, `robots_unavailable`, HTTP, timeout and redirect-policy reasons. Implement the new stated policy.

Date traps:

- Sitemap `lastmod` is a refresh hint, never a fact/publication date. The domain migration re-stamped many old posts. Event sitemap `lastmod` may even reflect future event dates.
- Use page JSON-LD `datePublished` and `dateModified` separately. Preserve `observed_at` when no content date exists.
- Old DB wrongly uses HTTP `Last-Modified` as `published_at` for 31 Blockspace docs and 30 Everstake pages. Do not copy that behavior.
- All 74 old docs.everstake.com rows and 11 GitHub README rows are undated. Docs should stay publication-unknown unless a page has an explicit date; GitHub files should use commit time as revision/modified provenance, not publication unless justified.
- `everstake.com/resources/crypto-reports` was assigned `2026-01-29` by page extraction although it is an index of reports; avoid letting a child/card date become the container page's publication date.
- YouTube `upload_date` is platform publication time, not necessarily recording/event time. Store both when the event date is evidenced.

Good W01 extraction fixtures already present:

- AI-directed content + explicit date: `prototype raw fixture: c4dcdeeffc1ee80a858f2c6629254668c246d080.html` (`https://everstake.com/ai-info`).
- Migrated historical article/date: `prototype raw fixture: 2f74652b29bb1982c3a6cc2c51635db2caad78cd.html`.
- Domain migration/redirect explanation: `prototype raw fixture: 9b907a7b1bc893fc1877eb836662aad62ccd723c.html`.
- Table/list-heavy institutional guide: `prototype raw fixture: a2e69d8def51143a8ae89a68e41c53bb7caf6503.html`.
- Reports index with misleading page date: `prototype raw fixture: a174c1eecb080feb57c877ad2cae7af9887fbdab.html`.
- Seed survey with headers/robots/sitemaps/text: `raw/survey/` (248 files), especially `raw/survey/meta/fetch_results.json` and `raw/survey/sitemaps/`.

## W02: docs, GitHub, audits and external material

GitHub live inventory via `GET /orgs/everstake/repos?per_page=100&type=public`: 69 repositories total, 15 public non-fork non-archived, 8 pushed in the last 12 months. Existing catalog and writeups: `docs/github-map/repos.json` and `docs/github-map/INDEX.md`. Use these only as discovery/QA notes; the new importer should call the API and fetch source files itself.

Practical GitHub inclusion rule: README and a small allowlisted set of content-bearing docs/config per repository; no source trees, binaries or generated/vendor code for count inflation. High-value paths to reproduce:

- `https://raw.githubusercontent.com/everstake/mcp/main/README.md` and `/tools.yaml` (MCP baseline/current static statements).
- `everstake/wallet-sdk` README and package/docs pages for supported SDKs.
- `everstake/everstake-swqos-docs` README/docs/examples for Landing/SWQoS naming history.
- `everstake/eigenlayer` operator metadata (current/withdrawn status needs file-level provenance).
- `everstake/eth2-batch-deposit-contract` README/contract docs.
- Historical repos (`eosmon`, `goz-relayer-helper`, `oasis-documentation`, `multiversx`) only when they add dated historical context. Exclude `chkrootkit` as vendored tooling and `i` as image-only.

External source candidates beyond the seed list, worth explicit source entries and PDF extraction:

- ChainSecurity audit PDF: `https://reports.chainsecurity.com/Everstake/ChainSecurity_Everstake_ETHB2CStaking_Audit.pdf`.
- Trail of Bits review in the auditor's public repository: `https://github.com/trailofbits/publications/blob/master/reviews/2025-1-everstake-ethereum-staking-protocol-securityreview.pdf` (fetch the raw PDF URL through the GitHub adapter).
- Ackee ETH2 batch-deposit audit summary: `https://ackee.xyz/blog/everstake-eth2-batch-deposit-contract-audit-summary/`; an older direct PDF is linked as `https://blog-api.everstake.one/assets/e4bb01b6-7728-4bb4-96bc-1a9a3be6f185.pdf`.
- Ethereum.org listing/issues contain dated, externally maintained product/audit claims and source links: `https://github.com/ethereum/ethereum-org-website/issues/11825` and `.../issues/17927`. Use as third-party, not as current pricing truth.
- Current Everstake pages name custody/integration partners Fireblocks, BitGo, Anchorage Digital, Zodia Custody, Copper, Coinbase Custody and Safe. Search each partner's own site for Everstake and accept only actual first-party partner pages; an Everstake press release alone is one origin.
- Keep the supplied syndication cluster as one provenance group. Existing raw pair: Chainwire `prototype raw fixture: 9b13319739fd17df139673602b97f361f713335b.html`; CryptoPotato `prototype raw fixture: 5cc3a5c17a8b924cf46272019d6abeb1159f7740.html` (cross-domain canonical points to Chainwire).
- Avoid search snippets as evidence. Medium, LinkedIn, Crunchbase, Investing and security resources have policy/access blockers already documented; do not bypass them.

Useful docs/code fixtures:

- Markdown table/API page: `prototype raw fixture: 419d74e9f2b96a39bb8a46f35d68e174416112e9.md` (Wallet SDK methods).
- MCP YAML as Markdown/text fixture: `prototype raw fixture: 4040816b09e2e6b5ec047211e4e1766425290401.md`.
- Old working DB and its URL->raw mapping: `claude-work/data/kb.db`.

