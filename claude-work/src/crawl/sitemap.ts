// Sitemap index + urlset parsing (regex is enough: the files are machine-generated).

import { politeFetch } from "./fetch.js";

export interface SitemapEntry { url: string; lastmod: string | null; sitemap: string }

export async function readSitemap(url: string, depth = 0): Promise<SitemapEntry[]> {
  if (depth > 2) return [];
  const res = await politeFetch(url);
  if (!res.ok) { console.warn(`  sitemap ${url} → ${res.error}`); return []; }
  const xml = res.body;
  const out: SitemapEntry[] = [];
  if (/<sitemapindex/i.test(xml)) {
    for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi)) {
      out.push(...(await readSitemap(m[1].trim(), depth + 1)));
    }
    return out;
  }
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const lastmod = m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1] ?? null;
    out.push({ url: decodeXml(loc.trim()), lastmod, sitemap: url });
  }
  return out;
}

const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
