// Polite HTTP: one request at a time per host, configurable delay (robots Crawl-delay wins),
// manual redirect following so the chain is recorded (it is our dedup evidence), retries.

import { getConfig } from "../config.js";
import { sleep } from "../util.js";
import { isAllowed, robotsFor } from "./robots.js";

export interface FetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  chain: { from: string; to: string; status: number }[];
  body: string;
  contentType: string;
  lastModified: string | null;
  bytes: number;
  error?: string;
  disallowed?: boolean;
}

const lastHit = new Map<string, number>();

export async function politeFetch(url: string, opts: { skipRobots?: boolean } = {}): Promise<FetchResult> {
  const cfg = getConfig().crawl;
  const chain: FetchResult["chain"] = [];
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const host = new URL(current).host;
    if (!opts.skipRobots) {
      const rules = await robotsFor(current);
      if (!isAllowed(rules, current)) return { ok: false, status: 0, finalUrl: current, chain, body: "", contentType: "", lastModified: null, bytes: 0, disallowed: true, error: "disallowed by robots.txt" };
      const delay = Math.max(cfg.delay_ms, rules.crawlDelayMs ?? 0);
      const wait = (lastHit.get(host) ?? 0) + delay - Date.now();
      if (wait > 0) await sleep(wait);
    }
    lastHit.set(host, Date.now());

    let res: Response | null = null;
    let err = "";
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        res = await fetch(current, {
          redirect: "manual",
          headers: { "User-Agent": cfg.user_agent, Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/xml;q=0.9,*/*;q=0.5", "Accept-Encoding": "gzip, br", "Accept-Language": "en" },
          signal: AbortSignal.timeout(cfg.timeout_ms),
        });
        if (res.status >= 500 || res.status === 429) { err = `http ${res.status}`; res = null; await sleep(1500 * (attempt + 1)); continue; }
        break;
      } catch (e: any) {
        err = String(e?.message ?? e);
        await sleep(1000 * (attempt + 1));
      }
    }
    if (!res) return { ok: false, status: 0, finalUrl: current, chain, body: "", contentType: "", lastModified: null, bytes: 0, error: err };

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, status: res.status, finalUrl: current, chain, body: "", contentType: "", lastModified: null, bytes: 0, error: "redirect without location" };
      const next = new URL(loc, current).toString();
      chain.push({ from: current, to: next, status: res.status });
      current = next;
      continue;
    }
    const body = await res.text();
    return {
      ok: res.ok, status: res.status, finalUrl: current, chain, body,
      contentType: res.headers.get("content-type") ?? "",
      lastModified: res.headers.get("last-modified"),
      bytes: Buffer.byteLength(body),
      error: res.ok ? undefined : `http ${res.status}`,
    };
  }
  return { ok: false, status: 0, finalUrl: current, chain, body: "", contentType: "", lastModified: null, bytes: 0, error: "too many redirects" };
}
