// Orchestrates the crawl: expand each source in config/sources.yaml into concrete targets,
// fetch politely, extract, store. Re-runs are idempotent (a URL already stored is skipped
// unless --force). Every dropped URL keeps its reason in the DB so the report can show it.

import fs from "node:fs";
import path from "node:path";
import { RAW_DIR, getConfig, sourcesConfig, type SourceDef } from "../config.js";
import { all, nowIso, one, run } from "../db.js";
import { canonicalKey, isSoftRoot } from "../index/canon.js";
import { domainOf, sha1, normalizeText } from "../util.js";
import { extractHtml, extractMarkdown, type Extracted } from "./extract.js";
import { politeFetch } from "./fetch.js";
import { readSitemap } from "./sitemap.js";
import { fetchVideo, listChannelVideos } from "./youtube.js";

interface Target { url: string; source: SourceDef; kind: "html" | "markdown" | "youtube"; hint?: { lastmod?: string | null } }

export async function crawl(opts: { force?: boolean; only?: string } = {}) {
  const cfg = getConfig();
  // `seed_only` domains may still be fetched when they appear verbatim in the seed list (to record redirects)
  const excludedFor = (sourceId: string) => sourcesConfig.excluded.filter((e) => !(e.seed_only && sourceId === "seed-list")).map((e) => e.domain);
  let stats = { targets: 0, fetched: 0, stored: 0, skipped: 0, dropped: 0 };

  for (const source of sourcesConfig.sources) {
    if (opts.only && source.id !== opts.only) continue;
    console.log(`\n▶ source ${source.id} (${source.kind}, tier ${source.tier})`);
    const targets = await expand(source);
    stats.targets += targets.length;
    console.log(`  ${targets.length} targets`);

    for (const t of targets) {
      const dom = domainOf(t.url);
      if (excludedFor(source.id).some((d) => dom === d || dom.endsWith("." + d))) { stats.dropped++; store(t, null, null, "dropped", "excluded domain (see config/sources.yaml)"); continue; }
      if (!opts.force && one("SELECT id FROM documents WHERE url = ?", t.url)) { stats.skipped++; continue; }

      if (t.kind === "youtube") {
        const v = await fetchVideo(t.url);
        stats.fetched++;
        if (!v || v.text.length < cfg.chunking.min_chars) { stats.dropped++; store(t, null, null, "dropped", v ? "no subtitles" : "yt-dlp failed"); continue; }
        const ex: Extracted = { title: `${v.title} (${v.channel}, YouTube)`, text: v.text, canonical: null, metaDescription: null, publishedAt: v.uploadDate, dateSource: "youtube:upload_date", modifiedAt: null, lang: "en" };
        store(t, { ok: true, status: 200, finalUrl: t.url, chain: [], bytes: v.text.length, lastModified: null }, ex, "ok", null);
        stats.stored++;
        console.log(`  ✓ video ${v.id} ${v.text.length} chars`);
        continue;
      }

      const res = await politeFetch(t.url);
      stats.fetched++;
      if (!res.ok) { stats.dropped++; store(t, res, null, "dropped", res.disallowed ? "disallowed by robots.txt" : res.error ?? `http ${res.status}`); console.log(`  ✗ ${t.url} → ${res.error}`); continue; }
      for (const hop of res.chain) run("INSERT OR IGNORE INTO redirects (from_url, to_url, status) VALUES (?,?,?)", hop.from, hop.to, hop.status);

      const isMd = t.kind === "markdown" || /text\/markdown|text\/plain/.test(res.contentType);
      const ex = isMd ? extractMarkdown(res.body, t.url) : extractHtml(res.body, t.url, res.lastModified);
      if (!ex.publishedAt && t.hint?.lastmod && source.id === "everstake-docs") { /* docs have no dates; leave null */ }

      if (isSoftRoot(t.url, res.finalUrl, ex.canonical)) { stats.dropped++; store(t, res, ex, "dropped", "soft-404: redirected/canonicalised to site root"); console.log(`  ✗ ${t.url} soft-404`); continue; }
      const minChars = isMd ? cfg.chunking.min_chars : cfg.chunking.min_html_chars;
      if (ex.text.length < minChars) { stats.dropped++; store(t, res, ex, "dropped", `too little text (${ex.text.length} chars)`); console.log(`  ✗ ${t.url} thin`); continue; }

      // keep raw html for offline re-processing
      const rawPath = path.join(RAW_DIR, sha1(t.url) + (isMd ? ".md" : ".html"));
      fs.writeFileSync(rawPath, res.body);
      store(t, res, ex, "ok", null, rawPath);
      stats.stored++;
      console.log(`  ✓ ${t.url} ${ex.text.length} chars ${ex.publishedAt ?? "undated"}${res.chain.length ? ` (${res.chain.length} redirect)` : ""}`);
    }
  }
  console.log("\ncrawl done", stats);
  return stats;
}

async function expand(source: SourceDef): Promise<Target[]> {
  const cfg = getConfig().crawl;
  switch (source.kind) {
    case "urls":
      return (source.urls ?? []).map((url) => ({ url, source, kind: "html" as const }));

    case "sitemap": {
      const entries = await readSitemap(source.url!);
      const blog = entries.filter((e) => /\/resources\/blog\/|\/blog\//.test(e.url));
      const rest = entries.filter((e) => !blog.includes(e));
      blog.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
      const keep = [...rest, ...blog.slice(0, cfg.max_blog_posts)];
      const seen = new Set<string>();
      return keep.filter((e) => { const k = canonicalKey(e.url); if (seen.has(k)) return false; seen.add(k); return true; })
        .map((e) => ({ url: e.url, source, kind: "html" as const, hint: { lastmod: e.lastmod } }));
    }

    case "llms-txt": {
      const res = await politeFetch(source.url!);
      if (!res.ok) return [];
      const base = new URL(source.url!).origin;
      const urls = new Set<string>();
      for (const m of res.body.matchAll(/\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g)) {
        let u = m[1].startsWith("/") ? base + m[1] : m[1];
        if (!u.startsWith(base)) continue;
        u = u.replace(/\.md$/, "").replace(/\/$/, "");
        urls.add(u + ".md"); // docs.everstake.com serves markdown at <path>.md
      }
      urls.add(base + "/llms.txt");
      return [...urls].map((url) => ({ url, source, kind: "markdown" as const }));
    }

    case "github-org": {
      const targets: Target[] = [];
      try {
        const res = await fetch(`https://api.github.com/orgs/${source.org}/repos?per_page=100&type=public`, { headers: { "User-Agent": cfg.user_agent, Accept: "application/vnd.github+json" } });
        if (res.ok) {
          const repos: any[] = await res.json();
          for (const r of repos.filter((r) => !r.fork && !r.archived)) {
            targets.push({ url: `https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/README.md`, source, kind: "markdown" });
          }
        } else console.warn("  github api", res.status);
      } catch (e) { console.warn("  github api failed", e); }
      for (const f of source.extra_files ?? []) targets.push({ url: f, source, kind: "markdown" });
      return targets;
    }

    case "youtube": {
      const urls = new Set(source.videos ?? []);
      if (source.channel) for (const u of await listChannelVideos(source.channel, cfg.youtube_channel_videos)) urls.add(u);
      return [...urls].map((url) => ({ url, source, kind: "youtube" as const }));
    }
  }
}

function store(t: Target, res: { ok: boolean; status: number; finalUrl: string; chain: any[]; bytes: number; lastModified: string | null } | null, ex: Extracted | null, status: "ok" | "dropped", dropReason: string | null, rawPath?: string) {
  const finalUrl = res?.finalUrl ?? t.url;
  const key = canonicalKey(ex?.canonical && !isSoftRoot(t.url, finalUrl, ex.canonical) ? ex.canonical : finalUrl);
  const text = ex?.text ?? null;
  run(
    `INSERT INTO documents (source_id, url, final_url, canonical_url, canonical_key, domain, category, tier, title, text, meta_description, lang,
       published_at, date_source, modified_at, fetched_at, http_status, html_bytes, text_chars, content_hash, status, drop_reason, raw_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET final_url=excluded.final_url, canonical_url=excluded.canonical_url, canonical_key=excluded.canonical_key,
       title=excluded.title, text=excluded.text, meta_description=excluded.meta_description, lang=excluded.lang, published_at=excluded.published_at,
       date_source=excluded.date_source, modified_at=excluded.modified_at, fetched_at=excluded.fetched_at, http_status=excluded.http_status,
       html_bytes=excluded.html_bytes, text_chars=excluded.text_chars, content_hash=excluded.content_hash, status=excluded.status,
       drop_reason=excluded.drop_reason, raw_path=excluded.raw_path, duplicate_of=NULL, dedup_method=NULL, similarity=NULL`,
    t.source.id, t.url, finalUrl, ex?.canonical ?? null, key, domainOf(finalUrl), t.source.category, t.source.tier,
    ex?.title ?? null, text, ex?.metaDescription ?? null, ex?.lang ?? null,
    ex?.publishedAt ?? null, ex?.dateSource ?? null, ex?.modifiedAt ?? null, nowIso(), res?.status ?? null, res?.bytes ?? null,
    text?.length ?? null, text ? sha1(normalizeText(text)) : null, status, dropReason, rawPath ?? null,
  );
}

export function crawlReport() {
  const byStatus = all(`SELECT status, COALESCE(drop_reason,'') reason, COUNT(*) n FROM documents GROUP BY status, reason ORDER BY n DESC`);
  const bySource = all(`SELECT source_id, tier, SUM(status='ok') ok, SUM(status='dropped') dropped, SUM(published_at IS NOT NULL AND status='ok') dated FROM documents GROUP BY source_id ORDER BY ok DESC`);
  return { byStatus, bySource };
}
