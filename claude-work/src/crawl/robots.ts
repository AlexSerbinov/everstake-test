// Pipeline: crawl, consulted before every single HTTP request (see fetch.ts).
// Decides whether we may request a URL at all, and how slowly. This is the one file where a
// mistake is not a bug but an incident: too permissive and we hammer a host that asked us not
// to; too strict and whole sources vanish from the corpus with no visible error.
//
// Deliberately a ~100-line subset of RFC 9309 rather than a dependency. We need exactly four
// things: group selection by user agent, longest-match Allow/Disallow precedence, the `*` and
// `$` wildcards, and Crawl-delay. Sitemap:, Host: and everything else are ignored on purpose.

import { getConfig } from "../config.js";

interface Rules {
  /** Allow patterns of the group(s) that apply to us, in file order. */
  allow: string[];
  /** Disallow patterns of the group(s) that apply to us, in file order. */
  disallow: string[];
  /** Largest Crawl-delay of the applicable groups, in ms; null when none was given. */
  crawlDelayMs: number | null;
  /** False only when the request itself threw (DNS/TLS/timeout) — a 404 still counts as fetched. */
  fetched: boolean;
  /** The host refused to serve robots.txt (403/5xx) → treat the whole origin as off limits. */
  blocked: boolean;
}

/** robots.txt is fetched at most once per origin per process — re-asking would itself be rude. */
const cache = new Map<string, Rules>();

/** Hand-tuned; robots.txt is a small static file, so a slow answer means the host is unhealthy. */
const ROBOTS_TIMEOUT_MS = 10_000;

// "Disallow: /private/" → ["Disallow", "/private/"]. The key charset is letters and "-" only, so
// a stray line such as a bare URL or a wrapped continuation simply fails to match and is skipped.
const DIRECTIVE_RE = /^([A-Za-z-]+)\s*:\s*(.*)$/;

/**
 * Fetch and cache the robots.txt rules that apply to our user agent at `url`'s origin.
 *
 * The interesting decision is what an *unusable* robots.txt means. We are asymmetric on purpose:
 *  • 403 / 5xx  → the host answered and refused. "We don't know the rules" must never be read as
 *    "go ahead", so the entire origin is marked blocked. This is stricter than RFC 9309 (which
 *    permits retrying a 5xx) and it costs us documents — investing.com returns 403 on robots.txt
 *    itself and is listed as excluded for exactly this reason (REPORT §2.1).
 *  • 404        → the host answered and has no rules at all. The spec reads that as "everything
 *    is allowed", and so do we.
 *  • thrown request (DNS, TLS, timeout) → nobody answered; RFC 9309 §2.3.1.4 treats an
 *    unreachable robots.txt as allow, and `fetched: false` records that we are guessing.
 */
export async function robotsFor(url: string): Promise<Rules> {
  const origin = new URL(url).origin;
  const cached = cache.get(origin);
  if (cached) return cached;

  const rules: Rules = { allow: [], disallow: [], crawlDelayMs: null, fetched: false, blocked: false };
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": getConfig().crawl.user_agent },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
    if (response.status === 403 || response.status >= 500) rules.blocked = true;
    else if (response.ok) applyRules(await response.text(), rules);
    rules.fetched = true;
  } catch {
    rules.fetched = false;
  }
  cache.set(origin, rules);
  return rules;
}

/** Parse the file, pick the groups meant for us, and merge them into `rules`. */
function applyRules(robotsTxt: string, rules: Rules) {
  // "EverstakeKB/0.1 (+https://…)" → "everstakekb": robots.txt names the bare product token,
  // without the version or the contact URL that belong in the HTTP header.
  const ourAgentToken = getConfig().crawl.user_agent.split("/")[0].toLowerCase();
  for (const group of pickGroupsForOurAgent(parseGroups(robotsTxt), ourAgentToken)) {
    rules.allow.push(...group.allow);
    rules.disallow.push(...group.disallow);
    // Several groups can name us; take the most conservative delay rather than the last one seen.
    if (group.delayMs) rules.crawlDelayMs = Math.max(rules.crawlDelayMs ?? 0, group.delayMs);
  }
}

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
  delayMs: number | null;
}

/** Split robots.txt into its `User-agent:` groups, keeping every group (selection comes later). */
function parseGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // Consecutive User-agent lines share one group ("User-agent: GPTBot\nUser-agent: EverstakeKB\n
  // Disallow: /shared/" bans /shared/ for both). The first non-agent line closes the header, so
  // the next User-agent line has to open a new group instead of joining this one.
  let previousLineWasUserAgent = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim(); // "Disallow: /x  # note" → "Disallow: /x"
    if (!line) continue;
    const directive = line.match(DIRECTIVE_RE);
    if (!directive) continue; // unparseable line: skip it without closing the current group
    const key = directive[1].toLowerCase();
    const value = directive[2].trim();

    if (key === "user-agent") {
      if (!current || !previousLineWasUserAgent) {
        current = { agents: [], allow: [], disallow: [], delayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousLineWasUserAgent = true;
      continue;
    }
    previousLineWasUserAgent = false;
    if (!current) continue; // a directive before the first User-agent line belongs to nobody

    if (key === "allow" && value) current.allow.push(value);
    // An empty "Disallow:" is the spec's way of saying "nothing is disallowed". It must not become
    // a pattern: "" matches every path and would silently block the whole host.
    else if (key === "disallow" && value) current.disallow.push(value);
    else if (key === "crawl-delay") {
      const seconds = Number(value); // "soon" → NaN, and NaN > 0 is false, so junk is ignored
      if (seconds > 0) current.delayMs = seconds * 1000;
    }
  }
  return groups;
}

/**
 * Which groups apply to us. Per RFC 9309 the most specific match wins *outright*: a group naming
 * our agent REPLACES the `*` group instead of adding to it, which is what lets a site hand us
 * narrower rules than it gives the general public. If no group names us, the `*` group applies.
 *
 * KNOWN LIMITATION: the test is `ourAgentToken.startsWith(groupAgent)`, not the exact token
 * comparison the RFC asks for. Any group whose name is a *prefix* of ours captures us — a block
 * written for a crawler called "Ever" would take precedence over the `*` block meant for us, and
 * could turn an allow into a site-wide ban. (A longer name such as "EverstakeKB-Images" is not a
 * prefix, so it is correctly ignored.) Left as-is because it is current, pinned behaviour; the
 * fix is `ourAgentToken === groupAgent`.
 */
function pickGroupsForOurAgent(groups: RobotsGroup[], ourAgentToken: string): RobotsGroup[] {
  const named = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && ourAgentToken.startsWith(agent)),
  );
  if (named.length) return named;
  return groups.filter((group) => group.agents.includes("*"));
}

/**
 * RFC 9309 precedence: the longest matching pattern wins, and a tie goes to Allow. The tie rule
 * matters because a site that writes both `Disallow: /a` and `Allow: /a` is granting an
 * exception, not repeating a ban — reading a tie as a ban would drop pages we were invited to.
 */
export function isAllowed(rules: Rules, url: string): boolean {
  if (rules.blocked) return false; // the host refused to serve robots.txt — see robotsFor
  const parsed = new URL(url);
  // Patterns are matched against path + query, so `Disallow: /page?print` can ban the printable
  // variant of a page while leaving /page itself crawlable.
  const path = parsed.pathname + parsed.search;
  const longestMatch = (patterns: string[]) =>
    patterns.reduce((longest, pattern) => Math.max(longest, matchLength(pattern, path)), -1);

  const allowLength = longestMatch(rules.allow);
  const disallowLength = longestMatch(rules.disallow);
  if (disallowLength < 0) return true; // nothing bans this path
  if (allowLength < 0) return false; // banned, with no exception carved out
  return allowLength >= disallowLength;
}

// Length of `pattern` when it matches `path`, else -1. It returns a length rather than a boolean
// because the length *is* the specificity score isAllowed compares.
//
// robots patterns are glob-ish, not regexes: `*` means any run of characters and a trailing `$`
// anchors the end of the path. Pattern "/*.pdf$" matches "/docs/report.pdf" but not
// "/docs/report.pdf?v=2"; pattern "/x/*/secret" matches "/x/any/thing/secret/deep" but not
// "/x/secret", because the literal slashes around the `*` still have to be there. Everything
// that is not a `*` or the final `$` is escaped, so a "." or "?" occurring literally in a URL
// path cannot start behaving like a regex metacharacter.
function matchLength(pattern: string, path: string): number {
  const literalSegments = pattern.split("*").map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  // Rejoin with ".*" for the wildcards, then turn a now-escaped trailing "\$" back into an anchor.
  const source = "^" + literalSegments.join(".*").replace(/\\\$$/, "$");
  return new RegExp(source).test(path) ? pattern.length : -1;
}
