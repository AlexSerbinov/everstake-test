// Pipeline: **crawl** → dedup → index → facts → retrieve → answer → eval. This is the entry
// point of the whole system (`npm run crawl`, src/cli.ts).
//
// What it does: expand each source in config/sources.yaml into concrete URLs, fetch them politely
// (fetch.ts + robots.ts), extract them (extract.ts), and write one row per URL into `documents`.
//
// Two properties are worth defending on their own:
//  • Re-runs are idempotent. A URL already in `documents` is skipped unless --force, so an
//    interrupted crawl is resumed by simply running it again.
//  • Nothing disappears silently. A URL that is excluded, blocked, redirected to the site root or
//    too thin still gets a row, with `status='dropped'` and a human-readable `drop_reason`. That
//    is what lets the report answer "why is this page not in the corpus?" months later, and it is
//    why the drop paths below store before they `continue`.

import fs from "node:fs";
import path from "node:path";
import { RAW_DIR, getConfig, sourcesConfig, type KbConfig, type SourceDef } from "../config.js";
import { all, nowIso, one, run } from "../db.js";
import { canonicalKey, isSoftRoot } from "../index/canon.js";
import { domainOf, sha1, normalizeText } from "../util.js";
import { extractHtml, extractMarkdown, type Extracted } from "./extract.js";
import { politeFetch, type FetchResult } from "./fetch.js";
import { readSitemap } from "./sitemap.js";
import { fetchVideo, listChannelVideos } from "./youtube.js";

interface Target {
  url: string;
  source: SourceDef;
  kind: "html" | "markdown" | "youtube";
  /** Sitemap metadata. `lastmod` orders blog posts by recency when trimming to max_blog_posts and
   *  is never written to `published_at`: the domain migration re-stamped 156 old posts (§2.2). */
  hint?: { lastmod?: string | null };
}

interface CrawlStats {
  /** URLs the sources expanded to, before any filtering. */
  targets: number;
  /** URLs we actually made a network request for (excludes rows skipped as already stored). */
  fetched: number;
  stored: number;
  skipped: number;
  dropped: number;
}

/** The parts of a fetch a stored row needs. The YouTube path has no HTTP response of its own and
 *  passes a synthetic one, which keeps `store` free of a second, mostly-null code path. */
type StoredResponse = Pick<FetchResult, "ok" | "status" | "finalUrl" | "chain" | "bytes" | "lastModified">;

/**
 * Crawl every configured source. `only` restricts the run to one source id, so a single source
 * can be re-worked without touching the rest of the corpus; `force` re-fetches URLs that are
 * already stored (otherwise they are counted as `skipped` and left alone).
 */
export async function crawl(opts: { force?: boolean; only?: string } = {}) {
  const config = getConfig();
  const stats: CrawlStats = { targets: 0, fetched: 0, stored: 0, skipped: 0, dropped: 0 };

  for (const source of sourcesConfig.sources) {
    if (opts.only && source.id !== opts.only) continue;
    console.log(`\n▶ source ${source.id} (${source.kind}, tier ${source.tier})`);
    const targets = await expand(source);
    stats.targets += targets.length;
    console.log(`  ${targets.length} targets`);
    // Sequential on purpose: politeFetch serialises per host anyway, and a flat loop keeps the
    // console log readable as a chronological record of the run.
    for (const target of targets) await crawlTarget(target, config, opts.force ?? false, stats);
  }

  console.log("\ncrawl done", stats);
  return stats;
}

/** Route one URL to the right handler, after the two checks that need no network at all. */
async function crawlTarget(target: Target, config: KbConfig, force: boolean, stats: CrawlStats) {
  if (isExcludedDomain(target)) {
    stats.dropped++;
    // Stored rather than skipped so the exclusion list is auditable against the corpus itself.
    store(target, null, null, "dropped", "excluded domain (see config/sources.yaml)");
    return;
  }
  if (!force && one("SELECT id FROM documents WHERE url = ?", target.url)) {
    stats.skipped++;
    return;
  }
  if (target.kind === "youtube") await crawlVideoTarget(target, config, stats);
  else await crawlPageTarget(target, config, stats);
}

/**
 * Domains listed under `excluded:` in sources.yaml (403s, robots disallows, verbatim copies).
 *
 * The `seed_only` flag is the exception: those domains are still fetched when the URL came from
 * the assignment's own seed list, because the redirect they produce is the evidence that the
 * legacy everstake.one domain is dead. Suppressing the fetch would leave that claim unsourced.
 */
function isExcludedDomain(target: Target): boolean {
  const domain = domainOf(target.url);
  return sourcesConfig.excluded
    .filter((exclusion) => !(exclusion.seed_only && target.source.id === "seed-list"))
    .some((exclusion) => domain === exclusion.domain || domain.endsWith("." + exclusion.domain));
}

/** A video document: yt-dlp subtitles instead of HTTP, everything downstream identical. */
async function crawlVideoTarget(target: Target, config: KbConfig, stats: CrawlStats) {
  const video = await fetchVideo(target.url);
  stats.fetched++;
  if (!video || video.text.length < config.chunking.min_chars) {
    stats.dropped++;
    // Two different failures, two different reasons: 10 of 23 channel videos had no usable
    // captions at all, which is a fact about the source, not a bug in the tooling.
    store(target, null, null, "dropped", video ? "no subtitles" : "yt-dlp failed");
    return;
  }
  const extracted: Extracted = {
    // Channel and platform go into the title so a citation reads as a video, not a web page —
    // ASR text is tier 3 and the reader should be able to see that from the citation alone.
    title: `${video.title} (${video.channel}, YouTube)`,
    text: video.text,
    canonical: null,
    metaDescription: null,
    publishedAt: video.uploadDate,
    dateSource: "youtube:upload_date",
    modifiedAt: null,
    lang: "en",
  };
  const syntheticResponse: StoredResponse = {
    ok: true,
    status: 200,
    finalUrl: target.url,
    chain: [],
    bytes: video.text.length,
    lastModified: null,
  };
  store(target, syntheticResponse, extracted, "ok", null);
  stats.stored++;
  console.log(`  ✓ video ${video.id} ${video.text.length} chars`);
}

/** An HTML or Markdown document: fetch, extract, reject the two kinds of junk, store. */
async function crawlPageTarget(target: Target, config: KbConfig, stats: CrawlStats) {
  const response = await politeFetch(target.url);
  stats.fetched++;
  if (!response.ok) {
    stats.dropped++;
    // "refused by the site" and "the request failed" are different stories and are recorded as
    // such; `http NNN` is the fallback for a failure that carried no message of its own.
    const reason = response.disallowed
      ? "disallowed by robots.txt"
      : response.error ?? `http ${response.status}`;
    store(target, response, null, "dropped", reason);
    console.log(`  ✗ ${target.url} → ${response.error}`);
    return;
  }
  // Recorded before anything can drop the document: the chain is the dedup layer's evidence that
  // two URLs are the same page, and it stays true even if this particular page is rejected below.
  for (const hop of response.chain) {
    run("INSERT OR IGNORE INTO redirects (from_url, to_url, status) VALUES (?,?,?)", hop.from, hop.to, hop.status);
  }

  // Either signal is enough. The source definition knows that docs pages and READMEs are
  // Markdown, and the content type catches the rest: raw.githubusercontent.com serves READMEs as
  // text/plain. Guessing wrong only costs quality — running the HTML extractor over Markdown
  // strips nothing but leaves the syntax in the text.
  const isMarkdown = target.kind === "markdown" || /text\/markdown|text\/plain/.test(response.contentType);
  const extracted = isMarkdown
    ? extractMarkdown(response.body, target.url)
    : extractHtml(response.body, target.url, response.lastModified);

  // Soft-404: the server answered 200 but sent us to the site root, so the "page" is actually the
  // home page wearing another URL. Indexing it would duplicate the home page N times.
  if (isSoftRoot(target.url, response.finalUrl, extracted.canonical)) {
    stats.dropped++;
    store(target, response, extracted, "dropped", "soft-404: redirected/canonicalised to site root");
    console.log(`  ✗ ${target.url} soft-404`);
    return;
  }
  // HTML gets the higher threshold: a client-rendered shell still ships a few hundred characters
  // of chrome, whereas a short Markdown file is genuinely short.
  const minChars = isMarkdown ? config.chunking.min_chars : config.chunking.min_html_chars;
  if (extracted.text.length < minChars) {
    stats.dropped++;
    store(target, response, extracted, "dropped", `too little text (${extracted.text.length} chars)`);
    console.log(`  ✗ ${target.url} thin`);
    return;
  }

  // The raw bytes are kept so extraction rules can be changed and replayed offline — re-running
  // the extractor over 441 saved files costs nothing and re-crawling the sites costs their
  // bandwidth. Named by sha1 of the URL so the mapping is reproducible.
  const rawPath = path.join(RAW_DIR, sha1(target.url) + (isMarkdown ? ".md" : ".html"));
  fs.writeFileSync(rawPath, response.body);
  store(target, response, extracted, "ok", null, rawPath);
  stats.stored++;
  console.log(
    `  ✓ ${target.url} ${extracted.text.length} chars ${extracted.publishedAt ?? "undated"}` +
      `${response.chain.length ? ` (${response.chain.length} redirect)` : ""}`,
  );
}

/** Turn one source definition into the concrete URLs to fetch. */
async function expand(source: SourceDef): Promise<Target[]> {
  const config = getConfig().crawl;
  switch (source.kind) {
    case "urls":
      return (source.urls ?? []).map((url) => ({ url, source, kind: "html" as const }));
    case "sitemap":
      return expandSitemap(source, config.max_blog_posts);
    case "llms-txt":
      return expandLlmsTxt(source);
    case "github-org":
      return expandGithubOrg(source, config.user_agent);
    case "youtube":
      return expandYoutube(source, config.youtube_channel_videos);
  }
}

/**
 * Sitemap → targets, with the blog capped.
 *
 * everstake.com's sitemap lists 629 blog posts; indexing all of them would spend most of the
 * corpus on old announcements, so only the newest `maxBlogPosts` are kept while every non-blog
 * page (products, docs, company, reports) is kept unconditionally. This is the ONE place
 * `lastmod` is used, and only to order posts against each other — it is a CMS edit timestamp, so
 * it is good enough to say "this post is newer than that one" and not good enough to be a date.
 */
async function expandSitemap(source: SourceDef, maxBlogPosts: number): Promise<Target[]> {
  const entries = await readSitemap(source.url!);
  // Both URL shapes exist because of the migration: /resources/blog/… now, /blog/… historically.
  const blogPosts = entries.filter((entry) => /\/resources\/blog\/|\/blog\//.test(entry.url));
  const blogPostSet = new Set(blogPosts);
  const otherPages = entries.filter((entry) => !blogPostSet.has(entry));
  blogPosts.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? "")); // newest first; undated last

  const kept = [...otherPages, ...blogPosts.slice(0, maxBlogPosts)];
  // A sitemap can list the same page under several URLs (trailing slash, /blog vs /resources/blog).
  // Collapsing them here saves the fetch entirely, rather than fetching twice and deduping later.
  const seenKeys = new Set<string>();
  return kept
    .filter((entry) => {
      const key = canonicalKey(entry.url);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    })
    .map((entry) => ({ url: entry.url, source, kind: "html" as const, hint: { lastmod: entry.lastmod } }));
}

/**
 * llms.txt → targets. The file is a Markdown link list a site publishes for AI clients, so every
 * link in it is a page the site itself nominated. docs.everstake.com serves each of those pages
 * as Markdown at `<path>.md`, which is why we rewrite the extension: fetching the .md variant
 * skips HTML cleaning entirely and yields cleaner text than the rendered page.
 */
async function expandLlmsTxt(source: SourceDef): Promise<Target[]> {
  const response = await politeFetch(source.url!);
  if (!response.ok) return []; // the source is simply empty this run; politeFetch already logged
  const origin = new URL(source.url!).origin;
  const urls = new Set<string>();

  // Markdown link targets: "[Overview](/docs/overview)" or "[API](https://docs.everstake.com/api)"
  // → the part inside the parentheses. Relative targets must start with "/".
  for (const link of response.body.matchAll(/\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g)) {
    let url = link[1].startsWith("/") ? origin + link[1] : link[1];
    if (!url.startsWith(origin)) continue; // llms.txt files link out to other sites; not our corpus
    // Normalise to exactly one ".md": strip an existing extension and any trailing slash first,
    // so "/api/", "/api" and "/api.md" all become the same "/api.md".
    url = url.replace(/\.md$/, "").replace(/\/$/, "");
    urls.add(url + ".md");
  }
  urls.add(origin + "/llms.txt"); // the index itself is a document: it states what the site offers
  return [...urls].map((url) => ({ url, source, kind: "markdown" as const }));
}

/**
 * Every public repo's README in a GitHub org, plus any extra files named in sources.yaml.
 *
 * This calls `fetch` directly rather than politeFetch because api.github.com is an API with its
 * own documented rate limits, not a site being crawled — robots.txt and a crawl delay do not
 * apply to it. The READMEs themselves are then fetched normally as raw.githubusercontent.com URLs.
 *
 * A failure here (rate limit, outage) costs the GitHub source and nothing else, so it is warned
 * about and swallowed rather than thrown.
 */
async function expandGithubOrg(source: SourceDef, userAgent: string): Promise<Target[]> {
  const targets: Target[] = [];
  try {
    // GITHUB_TOKEN is optional and needs no scopes for public repos: it only lifts the
    // unauthenticated 60-requests-per-hour-per-IP budget to 5 000, which a shared host or a
    // scheduled refresh exhausts quickly. The refresher sends the same header.
    const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(`https://api.github.com/orgs/${source.org}/repos?per_page=100&type=public`, { headers });
    if (response.ok) {
      const repos: any[] = await response.json();
      // Forks are someone else's text and archived repos describe abandoned code — both would be
      // indexed as if Everstake were saying it today.
      for (const repo of repos.filter((repo) => !repo.fork && !repo.archived)) {
        targets.push({
          url: `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/README.md`,
          source,
          kind: "markdown",
        });
      }
    } else console.warn("  github api", response.status);
  } catch (error) {
    console.warn("  github api failed", error);
  }
  for (const extraFile of source.extra_files ?? []) targets.push({ url: extraFile, source, kind: "markdown" });
  return targets;
}

/** Seed video URLs plus the newest channel uploads. The Set collapses a seed that is also in the
 *  channel listing, which would otherwise be fetched and stored twice. */
async function expandYoutube(source: SourceDef, channelVideoLimit: number): Promise<Target[]> {
  const urls = new Set(source.videos ?? []);
  if (source.channel) {
    for (const url of await listChannelVideos(source.channel, channelVideoLimit)) urls.add(url);
  }
  return [...urls].map((url) => ({ url, source, kind: "youtube" as const }));
}

/**
 * Write (or overwrite) the one row this URL owns. Keyed on `url` — the URL we asked for — so a
 * re-crawl updates in place and the seed URL always stays findable, even when it redirected.
 *
 * Two details carry weight:
 *  • `canonical_key` prefers the page's own <link rel=canonical> over the final URL, because that
 *    is the site telling us which of its URLs is the real one; a canonical pointing at the site
 *    root is ignored, since that is the soft-404 signature rather than a canonicalisation.
 *  • The upsert clears `duplicate_of`, `dedup_method` and `similarity`. New content invalidates
 *    the previous run's dedup verdict, and a stale "this is a duplicate of X" would hide a page
 *    that has since diverged. The dedup pass re-runs and decides again.
 */
function store(
  target: Target,
  response: StoredResponse | null,
  extracted: Extracted | null,
  status: "ok" | "dropped",
  dropReason: string | null,
  rawPath?: string,
) {
  const finalUrl = response?.finalUrl ?? target.url;
  const canonicalSource =
    extracted?.canonical && !isSoftRoot(target.url, finalUrl, extracted.canonical) ? extracted.canonical : finalUrl;
  const key = canonicalKey(canonicalSource);
  const text = extracted?.text ?? null;
  run(
    `INSERT INTO documents (source_id, url, final_url, canonical_url, canonical_key, domain, category, tier, title, text, meta_description, lang,
       published_at, date_source, modified_at, fetched_at, http_status, html_bytes, text_chars, content_hash, status, drop_reason, raw_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET final_url=excluded.final_url, canonical_url=excluded.canonical_url, canonical_key=excluded.canonical_key,
       title=excluded.title, text=excluded.text, meta_description=excluded.meta_description, lang=excluded.lang, published_at=excluded.published_at,
       date_source=excluded.date_source, modified_at=excluded.modified_at, fetched_at=excluded.fetched_at, http_status=excluded.http_status,
       html_bytes=excluded.html_bytes, text_chars=excluded.text_chars, content_hash=excluded.content_hash, status=excluded.status,
       drop_reason=excluded.drop_reason, raw_path=excluded.raw_path, duplicate_of=NULL, dedup_method=NULL, similarity=NULL`,
    target.source.id, target.url, finalUrl, extracted?.canonical ?? null, key, domainOf(finalUrl), target.source.category, target.source.tier,
    extracted?.title ?? null, text, extracted?.metaDescription ?? null, extracted?.lang ?? null,
    extracted?.publishedAt ?? null, extracted?.dateSource ?? null, extracted?.modifiedAt ?? null, nowIso(), response?.status ?? null, response?.bytes ?? null,
    // The hash is over normalised text, so a page that only changed its whitespace or casing is
    // recognised as unchanged, and identical pages on two domains hash identically for dedup.
    text?.length ?? null, text ? sha1(normalizeText(text)) : null, status, dropReason, rawPath ?? null,
  );
}

/**
 * The two tables `npm run crawl -- --report` prints: what was kept and dropped overall, and how
 * each source performed. `dated` is the column to watch — a source whose documents mostly have no
 * publication date will be ranked with the flat `undated_recency` multiplier instead of by age.
 */
export function crawlReport() {
  const byStatus = all(
    `SELECT status, COALESCE(drop_reason,'') reason, COUNT(*) n FROM documents GROUP BY status, reason ORDER BY n DESC`,
  );
  const bySource = all(
    `SELECT source_id, tier, SUM(status='ok') ok, SUM(status='dropped') dropped, SUM(published_at IS NOT NULL AND status='ok') dated
     FROM documents GROUP BY source_id ORDER BY ok DESC`,
  );
  return { byStatus, bySource };
}
