// `npm run refresh` — keep the corpus current without re-crawling it.
//
// Pipeline position: this is the loop that closes crawl → dedup → index → facts back on itself.
// The initial pipeline is a cold build; this is the warm one, and its whole design goal is that
// a run which finds nothing should cost nothing.
//
// HOW A RUN GOES
//   1. Pick the due work. Every document carries `checked_at`; its source type's interval says
//      how stale that may be. Nothing else is looked at.
//   2. Discovery, once per type, not once per document: one sitemap read settles the lastmod of
//      336 site pages, one `GET /orgs/everstake/repos` settles the pushed_at of 11 repos, one
//      llms.txt read lists the docs pages. This is also where NEW and REMOVED are noticed.
//   3. The three sieves, cheapest first (src/refresh/sieves.ts): sitemap lastmod → conditional
//      GET with the stored ETag/Last-Modified → sha1 of the normalised text. A document that
//      survives all three genuinely changed.
//   4. Only then does `depth` spend anything: re-chunk + re-embed at `reindex`, plus a fact
//      re-extraction at `refacts`. `check` stores the new text and logs the change, deliberately
//      leaving the index stale and saying so in the log.
//   5. Everything observed is written to `refresh_changes`, and the run's tallies to
//      `refresh_runs`. The corpus itself cannot answer "what changed" — a re-crawled page
//      overwrites the evidence — so this log is the only place that memory exists.
//
// GitHub gets its own path, per docs/github-map/refresh-plan.md: the org listing is the sieve,
// and a repo whose `pushed_at` moved is summarised from `commits?since=` rather than by
// re-reading its README, which is usually unchanged even when the code is not.
//
// The whole run is wrapped by the CLI in `withStageMetrics("refresh")`, so its wall time, CPU,
// peak RSS and bytes land in the same ledger as every other stage and the cost view can price it.

import { getConfig, sourcesConfig } from "../config.js";
import { all, nowIso, one, run as sql } from "../db.js";
import { extractHtml, extractMarkdown } from "../crawl/extract.js";
import { politeFetch } from "../crawl/fetch.js";
import { readSitemap } from "../crawl/sitemap.js";
import { reindexDocuments } from "../index/build.js";
import { extractFacts } from "../index/facts.js";
import { complete } from "../llm.js";
import { addStageBytes, currentRunId, currentStageBytes, reportStageItems, setStageMeta } from "../metrics.js";
import { canonicalKey, isSoftRoot } from "../index/canon.js";
import { domainOf, normalizeText, sha1 } from "../util.js";
import {
  INTERVAL_HOURS, SOURCE_TYPES, classifySourceType, depthAtLeast, normalisePolicy,
  type FreshnessPolicy, type SourceType,
} from "./policy.js";
import { conditionalValidators, isDue, lastmodVerdict, pushedAtVerdict, responseVerdict } from "./sieves.js";

/** Commits summarised into a repo document per run. Beyond this the summary stops being a
 *  summary; the count is in the detail line so nothing is silently truncated. */
const MAX_COMMITS_SUMMARISED = 40;

/** Characters of commit list handed to the model. A 40-commit list is ~3 kB. */
const MAX_COMMIT_TEXT_CHARS = 6000;

/** Tokens for the commit summary. Three or four sentences, not an essay. */
const COMMIT_SUMMARY_MAX_TOKENS = 400;

/** New pages discovered in one run, per type. A sitemap that suddenly lists 400 new URLs is a
 *  site restructure, not a week's work, and indexing it unattended is how a refresh turns into
 *  an unplanned $2 crawl. Above this the surplus is logged and left for `npm run crawl`. */
const MAX_NEW_DOCS_PER_TYPE = 25;

export interface RefreshOptions {
  /** Ignore `checked_at` and treat every document of the selected types as due. */
  force?: boolean;
  /** Restrict the run to these source types. */
  only?: SourceType[];
  /** Run every sieve and report, but write nothing and spend nothing. */
  dryRun?: boolean;
  /** Cap on documents checked, for a cheap smoke test. */
  limit?: number;
  /** Use this policy instead of `freshness.active` in the config. */
  policy?: FreshnessPolicy;
  /** Name recorded on the run row; defaults to the configured preset. */
  preset?: string;
}

export interface RefreshResult {
  run_id: string;
  preset: string;
  types: SourceType[];
  due: number;
  checked: number;
  conditional_gets: number;
  not_modified: number;
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
  reindexed: number;
  refacted: number;
  facts_changed: number;
  errors: number;
  cost_usd: number;
  dry_run: boolean;
  changes: ChangeRow[];
}

export interface ChangeRow {
  kind: "new" | "changed" | "removed" | "fact_changed" | "index_stale" | "error";
  source_type: SourceType | null;
  doc_id: number | null;
  url: string | null;
  title: string | null;
  detail: string;
  fact_key?: string | null;
  old_value?: string | null;
  new_value?: string | null;
}

/** A document as the refresher needs it. */
interface DueDoc {
  id: number;
  url: string;
  final_url: string | null;
  title: string | null;
  category: string;
  content_hash: string | null;
  text_chars: number | null;
  etag: string | null;
  last_modified_header: string | null;
  sitemap_lastmod: string | null;
  last_pushed_at: string | null;
  checked_at: string | null;
  type: SourceType;
}

/**
 * One refresh pass. Returns the tallies and the change list; also writes both to the database
 * unless `dryRun`.
 */
export async function refresh(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const cfg = getConfig();
  const policy = opts.policy ?? normalisePolicy(cfg.freshness.active, cfg.freshness.active as FreshnessPolicy);
  const preset = opts.preset ?? cfg.freshness.preset ?? "custom";
  // Outside a measured stage (a unit test, a REPL) there is no run id; the log still wants a key.
  const runId = currentRunId() ?? `refresh-${Date.now().toString(36)}`;
  const now = new Date();

  const selectedTypes = (opts.only?.length ? opts.only : [...SOURCE_TYPES])
    .filter((type) => policy[type].interval !== "never");

  const state: RunState = {
    runId, changes: [], counts: emptyCounts(), dryRun: opts.dryRun === true,
    reindexQueue: [], refactQueue: [], factsBefore: new Map(),
  };

  const due = selectDueDocuments(selectedTypes, policy, now, opts);
  state.counts.due = due.length;
  console.log(`refresh: preset=${preset}${opts.dryRun ? " (dry run)" : ""}, types=${selectedTypes.join(",") || "none"}, ${due.length} documents due`);

  // Discovery is per type and happens once, even though its results are consulted per document.
  const discovery = await discover(selectedTypes, due, state);

  for (const doc of due) {
    await refreshDocument(doc, policy, discovery, state);
  }

  await handleGithub(selectedTypes, policy, due, discovery, state);
  await applyDepthWork(policy, state);

  const cost = runCostUsd(runId);
  reportStageItems(state.counts.checked, "documents");
  setStageMeta({ preset, types: selectedTypes, ...state.counts });

  const result: RefreshResult = {
    run_id: runId, preset, types: selectedTypes, ...state.counts,
    cost_usd: cost, dry_run: state.dryRun, changes: state.changes,
  };
  if (!state.dryRun) writeRunRow(result, policy, now);
  console.log(`refresh done: ${summarise(result)}`);
  return result;
}

// --- run state ------------------------------------------------------------------------------

interface Counts {
  due: number; checked: number; conditional_gets: number; not_modified: number; unchanged: number;
  changed: number; added: number; removed: number; reindexed: number; refacted: number;
  facts_changed: number; errors: number;
}

const emptyCounts = (): Counts => ({
  due: 0, checked: 0, conditional_gets: 0, not_modified: 0, unchanged: 0, changed: 0, added: 0,
  removed: 0, reindexed: 0, refacted: 0, facts_changed: 0, errors: 0,
});

interface RunState {
  runId: string;
  changes: ChangeRow[];
  counts: Counts;
  dryRun: boolean;
  /** Documents to re-chunk and re-embed once every sieve has run. Batched so the embedding
   *  provider is called once for the whole run rather than once per changed page. */
  reindexQueue: number[];
  refactQueue: number[];
  /** doc id → its fact ledger before re-extraction, so a changed VALUE can be reported. */
  factsBefore: Map<number, Map<string, string>>;
}

/** Record one observation. Written straight through to the log table, so an interrupted run
 *  still leaves behind what it had already found, and echoed to the console so a long run is
 *  watchable rather than silent for four minutes. */
function note(state: RunState, change: ChangeRow) {
  state.changes.push(change);
  console.log(`  · ${change.kind.padEnd(13)} ${(change.url ?? "").slice(0, 72)}  ${change.detail.slice(0, 60)}`);
  if (state.dryRun) return;
  sql(
    `INSERT INTO refresh_changes (run_id, ts, kind, source_type, doc_id, url, title, detail, fact_key, old_value, new_value)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    state.runId, nowIso(), change.kind, change.source_type, change.doc_id, change.url,
    change.title, change.detail, change.fact_key ?? null, change.old_value ?? null, change.new_value ?? null);
}

// --- step 1: what is due --------------------------------------------------------------------

/**
 * Documents whose type is selected and whose `checked_at` is older than that type's interval.
 *
 * Aliases and dropped documents are excluded: an alias is not indexed, so refreshing it would
 * spend money on text nobody can retrieve, and a page dropped for robots or thinness was a
 * decision, not an accident. Ordered oldest-check-first so a `--limit` run makes progress
 * through the corpus rather than re-checking the same head every time.
 */
function selectDueDocuments(
  types: SourceType[], policy: FreshnessPolicy, now: Date, opts: RefreshOptions,
): DueDoc[] {
  const selected = new Set(types);
  const rows = all<Omit<DueDoc, "type">>(
    `SELECT id, url, final_url, title, category, content_hash, text_chars, etag, last_modified_header,
            sitemap_lastmod, last_pushed_at, checked_at
     FROM documents WHERE status = 'ok' AND duplicate_of IS NULL
     ORDER BY COALESCE(checked_at, '') ASC, id ASC`);

  const due: DueDoc[] = [];
  for (const row of rows) {
    const type = classifySourceType(row.final_url ?? row.url, row.category);
    if (!selected.has(type)) continue;
    if (!opts.force && !isDue(row.checked_at, INTERVAL_HOURS[policy[type].interval], now)) continue;
    due.push({ ...row, type });
    if (opts.limit && due.length >= opts.limit) break;
  }
  return due;
}

// --- step 2: discovery ------------------------------------------------------------------------

interface Discovery {
  /** canonical key → the sitemap `lastmod` seen this run. */
  sitemapLastmod: Map<string, string | null>;
  /** Whether a sitemap was read at all this run — without it, sieve 1 must be skipped rather
   *  than treated as "not listed", which would re-fetch the whole site. */
  sitemapRead: boolean;
  /** repo full name → pushed_at, from one org listing. */
  repoPushedAt: Map<string, { pushed_at: string; default_branch: string; name: string }>;
  githubRead: boolean;
}

/**
 * One discovery pass per type family. Cheap by construction: at most a handful of requests, and
 * each one settles dozens or hundreds of documents.
 */
async function discover(types: SourceType[], due: DueDoc[], state: RunState): Promise<Discovery> {
  const discovery: Discovery = {
    sitemapLastmod: new Map(), sitemapRead: false, repoPushedAt: new Map(), githubRead: false,
  };

  const needsSitemap = types.some((type) => ["live_pages", "blog", "reports_events"].includes(type));
  if (needsSitemap && due.some((doc) => ["live_pages", "blog", "reports_events"].includes(doc.type))) {
    const source = sourcesConfig.sources.find((entry) => entry.kind === "sitemap" && entry.id === "everstake-site");
    if (source?.url) {
      const entries = await readSitemap(source.url);
      for (const entry of entries) discovery.sitemapLastmod.set(canonicalKey(entry.url), entry.lastmod);
      discovery.sitemapRead = entries.length > 0;
      console.log(`  sitemap: ${entries.length} URLs listed`);
      await noticeNewAndRemoved(entries, types, state);
    }
  }

  if (types.includes("github") && due.some((doc) => doc.type === "github")) {
    const source = sourcesConfig.sources.find((entry) => entry.kind === "github-org");
    if (source?.org) {
      const repos = await listOrgRepos(source.org);
      for (const repo of repos) discovery.repoPushedAt.set(repo.full_name, repo);
      discovery.githubRead = repos.length > 0;
      console.log(`  github: ${repos.length} public repos listed`);
    }
  }

  return discovery;
}

/**
 * URLs the sitemap lists that the corpus does not have (new), and URLs the corpus has that the
 * sitemap no longer lists (removed).
 *
 * "Removed" is recorded, not acted on. A sitemap that omits a page may mean the page is gone or
 * may mean the CMS had a bad morning, and silently dropping 300 documents because of the second
 * case is not a recoverable mistake. A document is only ever marked dropped when the origin
 * itself answers 404/410 to a conditional GET, which happens in `refreshDocument`.
 */
async function noticeNewAndRemoved(
  entries: { url: string; lastmod: string | null }[], types: SourceType[], state: RunState,
) {
  const known = new Set(all<{ canonical_key: string }>("SELECT canonical_key FROM documents").map((row) => row.canonical_key));
  const selected = new Set(types);
  const perType = new Map<SourceType, number>();
  const frontier = crawlFrontier();

  // Newest first, so a cap that bites keeps the pages most likely to matter.
  const candidates = [...entries].sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));

  for (const entry of candidates) {
    const key = canonicalKey(entry.url);
    if (known.has(key)) continue;
    const type = classifySourceType(entry.url, "site");
    if (!selected.has(type)) continue;

    // The corpus was built with `crawl.max_blog_posts` newest posts of 629, and 379 old ones
    // were left out on purpose (REPORT §5). A refresh must not quietly undo that decision, so a
    // URL the sitemap already advertised when we crawled is not "new" — it was declined. Only a
    // URL whose lastmod is later than our newest crawl is something that appeared since.
    if (frontier && entry.lastmod && entry.lastmod < frontier) continue;

    const seen = perType.get(type) ?? 0;
    if (seen >= MAX_NEW_DOCS_PER_TYPE) continue;
    perType.set(type, seen + 1);
    known.add(key);
    await ingestNewPage(entry.url, type, state);
  }

  // The other direction. Restricted to documents that CAME from this sitemap: a seed URL such
  // as /llms.txt or a security-subdomain page was never in it, and reporting those as "removed"
  // every run would bury the one line that means something.
  const siteTypes: SourceType[] = ["live_pages", "blog", "reports_events"];
  const listed = new Set(entries.map((entry) => canonicalKey(entry.url)));
  for (const doc of all<{ id: number; url: string; final_url: string | null; title: string | null; canonical_key: string; category: string }>(
    `SELECT id, url, final_url, title, canonical_key, category FROM documents
     WHERE status = 'ok' AND duplicate_of IS NULL AND source_id = 'everstake-site'`)) {
    const type = classifySourceType(doc.final_url ?? doc.url, doc.category);
    if (!siteTypes.includes(type) || !selected.has(type)) continue;
    if (listed.has(doc.canonical_key)) continue;
    state.counts.removed++;
    note(state, {
      kind: "removed", source_type: type, doc_id: doc.id, url: doc.final_url ?? doc.url, title: doc.title,
      detail: "no longer listed in the sitemap — recorded only; the document is kept until the origin returns 404/410",
    });
  }

  for (const [type, count] of perType) {
    if (count >= MAX_NEW_DOCS_PER_TYPE) {
      note(state, {
        kind: "error", source_type: type, doc_id: null, url: null, title: null,
        detail: `more than ${MAX_NEW_DOCS_PER_TYPE} new ${type} URLs appeared at once — the surplus was left for a full \`npm run crawl\``,
      });
    }
  }
}

/**
 * The moment after which a sitemap entry is genuinely new, rather than one a full crawl already
 * saw and declined.
 *
 * It is the start of the most recent **crawl** stage run, deliberately not the newest
 * `fetched_at` in the corpus: a refresh updates `fetched_at` on every page it re-fetches, so a
 * frontier defined that way would creep forward to "a few minutes ago" after every run and
 * silently stop recognising anything as new. The crawl frontier only moves when someone
 * deliberately re-crawls, which is exactly when the "we saw this and declined it" decision was
 * last taken.
 *
 * Falls back to the newest `fetched_at` when no crawl run was measured (an imported database),
 * and to null on an empty corpus — which disables the check and lets the first refresh ingest
 * whatever the sitemap lists.
 */
function crawlFrontier(): string | null {
  // `--only` runs are excluded: repairing one source (`crawl --only=youtube`) never looked at
  // the sitemap, so it cannot have declined anything in it, and letting it move the frontier
  // would hide every page published before the repair.
  const crawl = one<{ at: string | null }>(
    `SELECT MAX(started_at) at FROM stage_runs
     WHERE stage = 'crawl' AND ok = 1 AND (meta IS NULL OR meta NOT LIKE '%"only"%')`);
  if (crawl?.at) return crawl.at;
  return one<{ at: string | null }>("SELECT MAX(fetched_at) at FROM documents")?.at ?? null;
}

/** Fetch, extract and store a page the corpus has never seen, then queue it for full indexing.
 *  A new document is always indexed and fact-extracted whatever the depth: it is not stale, it
 *  is absent, and no policy usefully chooses to leave it out. */
async function ingestNewPage(url: string, type: SourceType, state: RunState) {
  if (state.dryRun) {
    state.counts.added++;
    note(state, { kind: "new", source_type: type, doc_id: null, url, title: null, detail: "would be fetched and indexed (dry run)" });
    return;
  }
  const response = await politeFetch(url);
  if (!response.ok) {
    state.counts.errors++;
    note(state, { kind: "error", source_type: type, doc_id: null, url, title: null, detail: `new URL could not be fetched: ${response.error}` });
    return;
  }
  const extracted = extractHtml(response.body, url, response.lastModified);
  const config = getConfig();
  if (isSoftRoot(url, response.finalUrl, extracted.canonical) || extracted.text.length < config.chunking.min_html_chars) {
    note(state, { kind: "error", source_type: type, doc_id: null, url, title: null, detail: "new URL skipped: soft-404 or too little text" });
    return;
  }
  // `everstake-site` / `site` / tier 1 are hardcoded because this path only ever runs on URLs
  // discovered in everstake.com's own sitemap — the one source that advertises pages we do not
  // yet hold. A new docs page, repo or video is discovered by its own source's mechanism.
  const inserted = sql(
    `INSERT INTO documents (source_id, url, final_url, canonical_url, canonical_key, domain, category, tier, title, text,
       meta_description, lang, published_at, date_source, modified_at, fetched_at, http_status, html_bytes, text_chars,
       content_hash, status, etag, last_modified_header, checked_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ok',?,?,?)
     ON CONFLICT(url) DO NOTHING`,
    "everstake-site", url, response.finalUrl, extracted.canonical, canonicalKey(extracted.canonical ?? response.finalUrl),
    domainOf(response.finalUrl), "site", 1, extracted.title, extracted.text, extracted.metaDescription, extracted.lang,
    extracted.publishedAt, extracted.dateSource, extracted.modifiedAt, nowIso(), response.status, response.bytes,
    extracted.text.length, sha1(normalizeText(extracted.text)), response.etag ?? null, response.lastModified, nowIso());

  const docId = Number(inserted.lastInsertRowid);
  state.counts.added++;
  state.reindexQueue.push(docId);
  state.refactQueue.push(docId);
  note(state, {
    kind: "new", source_type: type, doc_id: docId, url, title: extracted.title,
    detail: `new page in the sitemap, ${extracted.text.length} characters, published ${extracted.publishedAt ?? "undated"}`,
  });
}

// --- step 3: the sieves, per document -----------------------------------------------------------

async function refreshDocument(doc: DueDoc, policy: FreshnessPolicy, discovery: Discovery, state: RunState) {
  // GitHub documents are settled entirely by `handleGithub`; checking their raw README URL with
  // a conditional GET would cost a request per repo and tell us less than the org listing does.
  if (doc.type === "github") return;
  // A video document's text is a yt-dlp subtitle track, not the watch page: fetching the URL over
  // HTTP returns a JavaScript shell with no transcript in it. Its own path, below.
  if (doc.type === "video") return refreshVideo(doc, policy, state);

  state.counts.checked++;

  // Sieve 1 — sitemap lastmod, no request of its own.
  const observedLastmod = discovery.sitemapLastmod.get(canonicalKey(doc.final_url ?? doc.url)) ?? null;
  if (discovery.sitemapRead && observedLastmod !== null) {
    const verdict = lastmodVerdict(doc.sitemap_lastmod, observedLastmod);
    if (verdict.skip) {
      state.counts.unchanged++;
      if (!state.dryRun) touchChecked(doc.id, { sitemap_lastmod: observedLastmod });
      return;
    }
  }

  if (state.dryRun) {
    // A dry run stops here: it can report what the free sieve concluded without making a request.
    state.counts.conditional_gets++;
    return;
  }

  // Sieve 2 — conditional GET. Offers whatever validators we stored; a document with none simply
  // gets an ordinary GET and is settled by sieve 3.
  const url = doc.final_url ?? doc.url;
  state.counts.conditional_gets++;
  const response = await politeFetch(url, { conditional: conditionalValidators(doc) });

  if (response.status === 404 || response.status === 410) {
    state.counts.removed++;
    sql("UPDATE documents SET status = 'dropped', drop_reason = ?, checked_at = ? WHERE id = ?",
      `gone: http ${response.status} at refresh`, nowIso(), doc.id);
    note(state, { kind: "removed", source_type: doc.type, doc_id: doc.id, url, title: doc.title,
      detail: `origin answered ${response.status}; the document was marked dropped` });
    return;
  }

  const extracted = response.notModified || !response.ok
    ? null
    : /text\/markdown|text\/plain/.test(response.contentType)
      ? extractMarkdown(response.body, url)
      : extractHtml(response.body, url, response.lastModified);

  // Sieve 3 — content hash over the normalised text, the same hash the crawler stores.
  const verdict = responseVerdict(response, extracted?.text ?? null, doc.content_hash, doc.text_chars);

  if (verdict.outcome === "not_modified") {
    state.counts.not_modified++;
    touchChecked(doc.id, { sitemap_lastmod: observedLastmod, etag: response.etag ?? doc.etag });
    return;
  }
  if (verdict.outcome === "error") {
    state.counts.errors++;
    touchChecked(doc.id, { sitemap_lastmod: observedLastmod });
    note(state, { kind: "error", source_type: doc.type, doc_id: doc.id, url, title: doc.title, detail: verdict.reason });
    return;
  }
  if (verdict.outcome === "unchanged") {
    state.counts.unchanged++;
    touchChecked(doc.id, {
      sitemap_lastmod: observedLastmod, etag: response.etag ?? null, last_modified_header: response.lastModified,
    });
    return;
  }

  state.counts.changed++;
  const depth = policy[doc.type].depth;
  note(state, {
    kind: "changed", source_type: doc.type, doc_id: doc.id, url, title: extracted!.title ?? doc.title,
    detail: verdict.reason,
  });

  if (!depthAtLeast(depth, "reindex")) {
    // Depth `check`: record that it changed and touch NOTHING else — not the text, not the hash,
    // not the ETag. Storing the new hash or the new validator would make the very next run report
    // this page as unchanged (or as a 304) while its chunks, embeddings and facts still describe
    // the old version: the corpus would be quietly stale and the log would say it was fine.
    // Leaving the old markers in place costs one body fetch per run and keeps the unresolved
    // change visible until someone raises the depth, which is the honest trade.
    sql("UPDATE documents SET checked_at = ? WHERE id = ?", nowIso(), doc.id);
    note(state, {
      kind: "index_stale", source_type: doc.type, doc_id: doc.id, url, title: doc.title,
      detail: "depth is `check`: the change is logged, the index still describes the old version, "
        + "and this page will keep being reported as changed until its depth is raised",
    });
    return;
  }

  // reindex or deeper: the corpus takes the new text, and the index follows below.
  storeChangedDocument(doc, extracted!, response, verdict.hash!, observedLastmod);
  state.reindexQueue.push(doc.id);
  if (depthAtLeast(depth, "refacts")) state.refactQueue.push(doc.id);
}

/** Mark a document checked without changing what it says. The cheap path, and the one taken by
 *  the overwhelming majority of documents in a healthy run. */
function touchChecked(docId: number, fields: { sitemap_lastmod?: string | null; etag?: string | null; last_modified_header?: string | null } = {}) {
  sql(
    `UPDATE documents SET checked_at = ?,
       sitemap_lastmod = COALESCE(?, sitemap_lastmod),
       etag = COALESCE(?, etag),
       last_modified_header = COALESCE(?, last_modified_header)
     WHERE id = ?`,
    nowIso(), fields.sitemap_lastmod ?? null, fields.etag ?? null, fields.last_modified_header ?? null, docId);
}

/** Write the new version of a changed document, keeping every field the crawler would set. */
function storeChangedDocument(
  doc: DueDoc,
  extracted: { title: string | null; text: string; canonical: string | null; metaDescription: string | null; publishedAt: string | null; dateSource: string | null; modifiedAt: string | null; lang: string | null },
  response: { status: number; bytes: number; etag?: string | null; lastModified: string | null; finalUrl: string },
  hash: string,
  observedLastmod: string | null,
) {
  sql(
    `UPDATE documents SET text = ?, title = COALESCE(?, title), meta_description = ?, published_at = COALESCE(?, published_at),
       date_source = COALESCE(?, date_source), modified_at = ?, fetched_at = ?, checked_at = ?, http_status = ?,
       html_bytes = ?, text_chars = ?, content_hash = ?, etag = ?, last_modified_header = ?, sitemap_lastmod = COALESCE(?, sitemap_lastmod)
     WHERE id = ?`,
    extracted.text, extracted.title, extracted.metaDescription, extracted.publishedAt, extracted.dateSource,
    extracted.modifiedAt, nowIso(), nowIso(), response.status, response.bytes, extracted.text.length, hash,
    response.etag ?? null, response.lastModified, observedLastmod, doc.id);
}

/**
 * Video documents: yt-dlp, not HTTP.
 *
 * There is no sitemap and no ETag for a subtitle track, so only sieve 3 applies — fetch the
 * captions and compare the hash. That is affordable precisely because the interval for this type
 * is monthly at every preset: an auto-generated transcript of a finished video is not rewritten,
 * and the reason to look at all is that YouTube occasionally *improves* its ASR for an old video.
 *
 * The shrink guard in `responseVerdict` applies here too, which is what stops a yt-dlp failure
 * (a rate limit, a video made private) from being recorded as "the transcript is now empty".
 */
async function refreshVideo(doc: DueDoc, policy: FreshnessPolicy, state: RunState) {
  state.counts.checked++;
  if (state.dryRun) return;

  const { fetchVideo } = await import("../crawl/youtube.js");
  const url = doc.final_url ?? doc.url;
  const video = await fetchVideo(url);
  const verdict = responseVerdict(
    { ok: video !== null, status: video ? 200 : 0, error: "yt-dlp returned no subtitles" },
    video?.text ?? null, doc.content_hash, doc.text_chars);

  if (verdict.outcome !== "changed") {
    touchChecked(doc.id);
    if (verdict.outcome === "unchanged") state.counts.unchanged++;
    else {
      state.counts.errors++;
      note(state, { kind: "error", source_type: "video", doc_id: doc.id, url, title: doc.title, detail: verdict.reason });
    }
    return;
  }

  state.counts.changed++;
  sql(
    `UPDATE documents SET text = ?, text_chars = ?, content_hash = ?, fetched_at = ?, checked_at = ? WHERE id = ?`,
    video!.text, video!.text.length, verdict.hash, nowIso(), nowIso(), doc.id);
  note(state, {
    kind: "changed", source_type: "video", doc_id: doc.id, url, title: doc.title,
    detail: `the auto-generated subtitles changed (${verdict.reason})`,
  });
  if (depthAtLeast(policy.video.depth, "reindex")) state.reindexQueue.push(doc.id);
  if (depthAtLeast(policy.video.depth, "refacts")) state.refactQueue.push(doc.id);
}

// --- GitHub -------------------------------------------------------------------------------------

/** GitHub requires a User-Agent; the token is optional and only raises the rate limit. */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": getConfig().crawl.user_agent,
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

interface OrgRepo { full_name: string; name: string; pushed_at: string; default_branch: string; archived: boolean; fork: boolean }

/** One call for the whole org. This is the GitHub sieve: 11 documents settled by one request,
 *  which is why the GitHub source can afford a daily interval at every preset. */
async function listOrgRepos(org: string): Promise<OrgRepo[]> {
  try {
    const response = await fetch(`https://api.github.com/orgs/${org}/repos?per_page=100&type=public`, {
      headers: githubHeaders(),
    });
    if (!response.ok) {
      // 403 here is almost always the unauthenticated 60-requests-per-hour budget, shared with
      // everything else on this IP. Set GITHUB_TOKEN (no scopes needed for public repos) to get
      // 5 000/hour — the refresh plan in docs/github-map/refresh-plan.md says so, and a
      // scheduled refresh on a shared runner will hit it otherwise.
      console.warn(`  github api ${response.status}${response.status === 403 ? " — set GITHUB_TOKEN to raise the rate limit" : ""}`);
      return [];
    }
    const body = await response.text();
    addStageBytes(Buffer.byteLength(body));
    return (JSON.parse(body) as OrgRepo[]).filter((repo) => !repo.fork && !repo.archived);
  } catch (error) {
    console.warn("  github api failed", error);
    return [];
  }
}

/**
 * The GitHub path, per docs/github-map/refresh-plan.md.
 *
 * A repo whose `pushed_at` has not moved costs nothing at all. One that has moved gets a single
 * `commits?since=` call, and the commit list is summarised into the repo's document by the cheap
 * model — the README itself is usually untouched by the very commits that matter, so reading it
 * again would be both a request and a lie about what changed.
 */
async function handleGithub(
  types: SourceType[], policy: FreshnessPolicy, due: DueDoc[], discovery: Discovery, state: RunState,
) {
  if (!types.includes("github") || !discovery.githubRead) return;
  const depth = policy.github.depth;
  // Two documents can belong to one repo — everstake/mcp contributes both its README and
  // `tools.yaml` — and they would otherwise each pay for their own commit list and their own
  // model call to summarise the same commits.
  const summaries = new Map<string, { summary: string; commits: number }>();

  for (const doc of due.filter((entry) => entry.type === "github")) {
    state.counts.checked++;
    // A repo document's URL is its raw README; the repo name is the path segment after the org.
    const match = (doc.final_url ?? doc.url).match(/githubusercontent\.com\/([^/]+\/[^/]+)\//)
      ?? (doc.final_url ?? doc.url).match(/github\.com\/([^/]+\/[^/]+)/);
    const repo = match ? discovery.repoPushedAt.get(match[1]) : undefined;
    const verdict = pushedAtVerdict(doc.last_pushed_at, repo?.pushed_at ?? null);
    if (verdict.skip) {
      state.counts.unchanged++;
      if (!state.dryRun) touchChecked(doc.id);
      continue;
    }
    if (!repo) {
      if (!state.dryRun) touchChecked(doc.id);
      continue; // an extra_files document (tools.yaml) — no repo of its own in the listing
    }
    if (state.dryRun) { state.counts.changed++; continue; }

    let cached = summaries.get(match![1]);
    if (!cached) {
      const since = doc.last_pushed_at ?? doc.checked_at;
      const commits = await fetchCommits(match![1], repo.default_branch, since);
      cached = { commits: commits.length, summary: commits.length ? await summariseCommits(repo.name, commits) : "" };
      summaries.set(match![1], cached);
    }
    if (cached.commits === 0) {
      // pushed_at moved but nothing landed on the default branch (a tag, a branch push).
      state.counts.unchanged++;
      sql("UPDATE documents SET checked_at = ?, last_pushed_at = ? WHERE id = ?", nowIso(), repo.pushed_at, doc.id);
      continue;
    }

    const { summary, commits: commitCount } = cached;
    state.counts.changed++;
    appendRepoActivity(doc, summary, repo.pushed_at, commitCount);
    note(state, {
      kind: "changed", source_type: "github", doc_id: doc.id, url: doc.final_url ?? doc.url, title: doc.title,
      detail: `pushed_at ${doc.last_pushed_at ?? "unknown"} → ${repo.pushed_at}; ${commitCount} commit${commitCount === 1 ? "" : "s"} summarised into the document`,
    });
    if (depthAtLeast(depth, "reindex")) state.reindexQueue.push(doc.id);
    if (depthAtLeast(depth, "refacts")) state.refactQueue.push(doc.id);
  }
}

interface Commit { sha: string; date: string; message: string; author: string }

/** Commit messages since a date. No diff is downloaded: messages are enough to say what moved,
 *  and a `compare` call per repo would multiply the cost of a quiet week by the number of repos. */
async function fetchCommits(fullName: string, branch: string, since: string | null): Promise<Commit[]> {
  const query = new URLSearchParams({ sha: branch, per_page: String(MAX_COMMITS_SUMMARISED) });
  if (since) query.set("since", since);
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/commits?${query}`, {
      headers: githubHeaders(),
    });
    if (!response.ok) return [];
    const body = await response.text();
    addStageBytes(Buffer.byteLength(body));
    return (JSON.parse(body) as any[]).map((entry) => ({
      sha: String(entry.sha).slice(0, 7),
      date: entry.commit?.committer?.date ?? entry.commit?.author?.date ?? "",
      message: String(entry.commit?.message ?? "").split("\n")[0],
      author: entry.commit?.author?.name ?? "unknown",
    }));
  } catch {
    return [];
  }
}

/** Turn a commit list into two or three sentences of prose that belong in a knowledge base.
 *  The cheap model, one call per changed repo — the whole GitHub budget of a quiet month. */
async function summariseCommits(repo: string, commits: Commit[]): Promise<string> {
  const list = commits.map((commit) => `${commit.date.slice(0, 10)} ${commit.sha} ${commit.message}`)
    .join("\n").slice(0, MAX_COMMIT_TEXT_CHARS);
  const result = await complete({
    stage: "facts",
    model: getConfig().models.cheap,
    maxTokens: COMMIT_SUMMARY_MAX_TOKENS,
    system:
      "You summarise a list of git commit messages for a knowledge base about a company. Write 2-4 plain sentences "
      + "stating what changed in the repository and what it implies about the product, if anything. Name concrete "
      + "features, files or versions when the messages do. Do not speculate beyond the messages. No bullet points, no preamble.",
    user: `Repository: ${repo}\n\nCommits since the last check:\n${list}`,
    meta: { repo },
  });
  return result.data.trim();
}

/**
 * Append the summary to the repo's document under a dated heading, and record the new
 * `pushed_at`.
 *
 * Appended, never overwritten: the README is first-party text we were given, and a model's
 * summary of commits is a different kind of claim. Keeping them in one document but visibly
 * separated means a citation to this page can still be checked against the page, and the fact
 * extractor sees the activity as dated prose rather than as part of the README.
 */
function appendRepoActivity(doc: DueDoc, summary: string, pushedAt: string, commitCount: number) {
  const heading = `\n\n## Repository activity as of ${pushedAt.slice(0, 10)}\n`;
  const body = `${commitCount} commit${commitCount === 1 ? "" : "s"} on the default branch since the previous check. ${summary}\n`;
  const current = one<{ text: string }>("SELECT text FROM documents WHERE id = ?", doc.id)?.text ?? "";
  // Replace a previous activity block rather than stacking one per run, or a weekly cadence
  // would turn a 3 kB README into a changelog nobody reads.
  const withoutOld = current.replace(/\n*## Repository activity as of[\s\S]*$/, "");
  const text = withoutOld + heading + body;
  sql(
    `UPDATE documents SET text = ?, text_chars = ?, content_hash = ?, fetched_at = ?, checked_at = ?, last_pushed_at = ?
     WHERE id = ?`,
    text, text.length, sha1(normalizeText(text)), nowIso(), nowIso(), pushedAt, doc.id);
}

// --- step 4: the depth work ---------------------------------------------------------------------

/**
 * Re-index and re-extract, once, at the end.
 *
 * Batched deliberately: embeddings are billed and rate-limited per request, and the fact
 * extractor runs four documents concurrently. Doing this inside the sieve loop would serialise
 * both behind the politeness delay of the next page.
 */
async function applyDepthWork(policy: FreshnessPolicy, state: RunState) {
  if (state.dryRun) return;

  const toReindex = [...new Set(state.reindexQueue)];
  if (toReindex.length) {
    const stats = await reindexDocuments(toReindex);
    state.counts.reindexed = stats.documents;
    console.log(`  re-indexed ${stats.documents} documents → ${stats.chunks} chunks, ${stats.embedded} embedded`);
  }

  const toRefact = [...new Set(state.refactQueue)];
  if (!toRefact.length) return;

  // Snapshot the ledger before the extractor replaces it — this is the only moment the old
  // values still exist, and "which fact changed value" is the headline the operator wants.
  for (const docId of toRefact) state.factsBefore.set(docId, factSnapshot(docId));
  const stats = await extractFacts({ docIds: toRefact });
  state.counts.refacted = stats.documents;
  console.log(`  re-extracted facts for ${stats.documents} documents ($${stats.cost_usd})`);

  for (const docId of toRefact) reportFactChanges(docId, state);
}

/** key → value for one document's current ledger. Keys can repeat within a document; the first
 *  row wins, which matches how the answerer reads a repeated key. */
function factSnapshot(docId: number): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const row of all<{ key: string; value: string }>("SELECT key, value FROM facts WHERE doc_id = ? ORDER BY id", docId)) {
    if (!snapshot.has(row.key)) snapshot.set(row.key, row.value);
  }
  return snapshot;
}

/** Compare the ledger before and after re-extraction and log every key whose VALUE moved.
 *  Keys that only appeared or only disappeared are logged too — a fact the page stopped
 *  asserting is as interesting as one whose number changed. */
function reportFactChanges(docId: number, state: RunState) {
  const before = state.factsBefore.get(docId) ?? new Map();
  const after = factSnapshot(docId);
  const doc = one<{ url: string; final_url: string | null; title: string | null; category: string }>(
    "SELECT url, final_url, title, category FROM documents WHERE id = ?", docId);
  if (!doc) return;
  const type = classifySourceType(doc.final_url ?? doc.url, doc.category);

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key) ?? null;
    const newValue = after.get(key) ?? null;
    if (oldValue === newValue) continue;
    state.counts.facts_changed++;
    note(state, {
      kind: "fact_changed", source_type: type, doc_id: docId, url: doc.final_url ?? doc.url, title: doc.title,
      detail: oldValue === null ? "a new fact appeared on this page"
        : newValue === null ? "this page no longer asserts the fact"
          : "the value changed",
      fact_key: key, old_value: oldValue, new_value: newValue,
    });
  }
}

// --- writing the run row and reading the log back --------------------------------------------

/** What the models charged during this run, from the ledger rather than from an accumulator —
 *  the same rule the cost report follows, so the two can be compared instead of one trusting
 *  the other. */
function runCostUsd(runId: string): number {
  const row = one<{ cost: number }>("SELECT COALESCE(SUM(cost_usd),0) cost FROM llm_calls WHERE run_id = ?", runId);
  return Number((row?.cost ?? 0).toFixed(6));
}

function writeRunRow(result: RefreshResult, policy: FreshnessPolicy, startedAt: Date) {
  // From the live stage context, not from `stage_runs`: that row is written by the wrapper's
  // `finally`, i.e. after this function has already run, so querying it here always found 0.
  const bytes = currentStageBytes();
  sql(
    `INSERT INTO refresh_runs (run_id, started_at, ended_at, policy, preset, types, due, checked, conditional_gets,
       not_modified, unchanged, changed, added, removed, reindexed, refacted, facts_changed, bytes_in, cost_usd, ok, dry_run)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0)
     ON CONFLICT(run_id) DO UPDATE SET ended_at=excluded.ended_at, due=excluded.due, checked=excluded.checked,
       conditional_gets=excluded.conditional_gets, not_modified=excluded.not_modified, unchanged=excluded.unchanged,
       changed=excluded.changed, added=excluded.added, removed=excluded.removed, reindexed=excluded.reindexed,
       refacted=excluded.refacted, facts_changed=excluded.facts_changed, cost_usd=excluded.cost_usd`,
    result.run_id, startedAt.toISOString(), nowIso(), JSON.stringify(policy), result.preset,
    JSON.stringify(result.types), result.due, result.checked, result.conditional_gets, result.not_modified,
    result.unchanged, result.changed, result.added, result.removed, result.reindexed, result.refacted,
    result.facts_changed, bytes, result.cost_usd);
}

/** The one-line console summary, also used by the scheduler's log. */
export function summarise(result: RefreshResult): string {
  return `${result.checked} checked · ${result.not_modified} not-modified · ${result.unchanged} unchanged · `
    + `${result.changed} changed · ${result.added} new · ${result.removed} removed · `
    + `${result.facts_changed} facts changed · $${result.cost_usd.toFixed(4)}`;
}

export interface RefreshLogRun {
  run_id: string; started_at: string; ended_at: string | null; preset: string | null;
  due: number; checked: number; conditional_gets: number; not_modified: number; unchanged: number;
  changed: number; added: number; removed: number; reindexed: number; refacted: number;
  facts_changed: number; bytes_in: number; cost_usd: number; wall_ms: number | null;
  changes: ChangeRow[];
}

/** The last N runs with their changes, for `GET /api/freshness/log` and the UI panel. */
export function refreshLog(limit = 5): RefreshLogRun[] {
  const runs = all<Omit<RefreshLogRun, "changes">>(
    `SELECT r.run_id, r.started_at, r.ended_at, r.preset, r.due, r.checked, r.conditional_gets, r.not_modified,
            r.unchanged, r.changed, r.added, r.removed, r.reindexed, r.refacted, r.facts_changed, r.bytes_in,
            r.cost_usd, s.wall_ms
     FROM refresh_runs r LEFT JOIN stage_runs s ON s.run_id = r.run_id
     WHERE r.dry_run = 0 ORDER BY r.id DESC LIMIT ?`, limit);
  return runs.map((row) => ({
    ...row,
    changes: all<ChangeRow>(
      `SELECT kind, source_type, doc_id, url, title, detail, fact_key, old_value, new_value
       FROM refresh_changes WHERE run_id = ? ORDER BY id`, row.run_id),
  }));
}

/**
 * Per source type: how many documents, when the oldest and newest of them were last checked.
 *
 * This is the "last refreshed" half of the UI panel, and it is computed from the documents
 * rather than from the run log on purpose — a run that skipped a type because it was not due
 * still leaves that type's real staleness visible.
 */
export function freshnessStatus(): { type: SourceType; documents: number; oldest_checked_at: string | null; newest_checked_at: string | null; never_checked: number }[] {
  const rows = all<{ url: string; final_url: string | null; category: string; checked_at: string | null }>(
    "SELECT url, final_url, category, checked_at FROM documents WHERE status = 'ok' AND duplicate_of IS NULL");
  return SOURCE_TYPES.map((type) => {
    const mine = rows.filter((row) => classifySourceType(row.final_url ?? row.url, row.category) === type);
    const checked = mine.map((row) => row.checked_at).filter((value): value is string => Boolean(value)).sort();
    return {
      type,
      documents: mine.length,
      oldest_checked_at: checked[0] ?? null,
      newest_checked_at: checked[checked.length - 1] ?? null,
      never_checked: mine.length - checked.length,
    };
  });
}
