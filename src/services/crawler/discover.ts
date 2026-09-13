import { load } from "cheerio";
import {
  discoverRobotsSitemaps,
  safeFetch,
  type SafeFetchOptions,
} from "./fetch.js";
import { normalizeUrl } from "./extract.js";

export interface SitemapDiscoveryResult {
  urls: string[];
  sitemaps: string[];
  errors: Array<{ url: string; reason: string }>;
}

/** Expands declared and fallback sitemaps, including bounded sitemap indexes. */
export async function discoverSitemaps(
  seedUrl: string,
  options: SafeFetchOptions & { maxSitemaps?: number; maxUrls?: number } = {},
): Promise<SitemapDiscoveryResult> {
  const origin = new URL(seedUrl).origin;
  const declared = await discoverRobotsSitemaps(seedUrl, options).catch(
    () => [],
  );
  const queue = [
    ...new Set([...declared, new URL("/sitemap.xml", origin).href]),
  ];
  const visited = new Set<string>();
  const urls = new Set<string>();
  const errors: SitemapDiscoveryResult["errors"] = [];
  const maxSitemaps = options.maxSitemaps ?? 20;
  const maxUrls = options.maxUrls ?? 5_000;
  while (queue.length && visited.size < maxSitemaps) {
    const sitemapUrl = normalizeUrl(queue.shift()!);
    if (visited.has(sitemapUrl) || new URL(sitemapUrl).origin !== origin)
      continue;
    visited.add(sitemapUrl);
    try {
      const response = await safeFetch(sitemapUrl, {
        ...options,
        maxBytes: Math.max(options.maxBytes ?? 0, 5_000_000),
      });
      const $ = load(response.body.toString("utf8"), { xmlMode: true });
      if ($("sitemapindex").length) {
        $("sitemap > loc").each((_, node) => {
          const value = $(node).text().trim();
          if (value) queue.push(new URL(value, sitemapUrl).href);
        });
      } else {
        $("url > loc").each((_, node) => {
          if (urls.size >= maxUrls) return false;
          const value = $(node).text().trim();
          if (value) urls.add(normalizeUrl(new URL(value, sitemapUrl).href));
        });
      }
    } catch (error) {
      errors.push({
        url: sitemapUrl,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { urls: [...urls], sitemaps: [...visited], errors };
}
