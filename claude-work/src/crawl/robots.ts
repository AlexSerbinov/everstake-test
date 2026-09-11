// Minimal robots.txt: longest-match Allow/Disallow per RFC 9309, Crawl-delay.
// We identify as our own UA (EverstakeKB). If a site answers 403/5xx for robots.txt
// we treat the whole host as disallowed — "unknown rules" must not mean "go ahead".

import { getConfig } from "../config.js";

interface Rules { allow: string[]; disallow: string[]; crawlDelayMs: number | null; fetched: boolean; blocked: boolean }

const cache = new Map<string, Rules>();

export async function robotsFor(url: string): Promise<Rules> {
  const host = new URL(url).origin;
  const hit = cache.get(host);
  if (hit) return hit;
  const rules: Rules = { allow: [], disallow: [], crawlDelayMs: null, fetched: false, blocked: false };
  try {
    const res = await fetch(`${host}/robots.txt`, { headers: { "User-Agent": getConfig().crawl.user_agent }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 403 || res.status >= 500) rules.blocked = true;
    else if (res.ok) parse(await res.text(), rules);
    rules.fetched = true;
  } catch {
    rules.fetched = false; // network error → assume allowed (RFC 9309 §2.3.1.4 treats unreachable as allow)
  }
  cache.set(host, rules);
  return rules;
}

function parse(txt: string, rules: Rules) {
  const ua = getConfig().crawl.user_agent.split("/")[0].toLowerCase();
  let groups: { agents: string[]; allow: string[]; disallow: string[]; delay: number | null }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" && val) cur.allow.push(val);
    else if (key === "disallow") { if (val) cur.disallow.push(val); }
    else if (key === "crawl-delay") { const n = Number(val); if (n > 0) cur.delay = n * 1000; }
  }
  // most specific matching group wins: exact UA token > "*"
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.startsWith(a)));
  const star = groups.filter((g) => g.agents.includes("*"));
  const use = mine.length ? mine : star;
  for (const g of use) { rules.allow.push(...g.allow); rules.disallow.push(...g.disallow); if (g.delay) rules.crawlDelayMs = Math.max(rules.crawlDelayMs ?? 0, g.delay); }
}

export function isAllowed(rules: Rules, url: string): boolean {
  if (rules.blocked) return false;
  const path = new URL(url).pathname + new URL(url).search;
  const best = (list: string[]) => list.map((p) => [p, matchLen(p, path)] as const).filter(([, l]) => l >= 0).sort((a, b) => b[1] - a[1])[0];
  const a = best(rules.allow), d = best(rules.disallow);
  if (!d) return true;
  if (!a) return false;
  return a[1] >= d[1]; // tie → Allow
}

/** Returns pattern length if it matches (supports * and $), else -1. */
function matchLen(pattern: string, path: string): number {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
  return re.test(path) ? pattern.length : -1;
}
