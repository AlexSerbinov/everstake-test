// Freshness policy: the vocabulary shared by the refresh runner, the cost calculator, the API
// and the UI. Nothing in here talks to the database or the network — it is types, the
// classification rule that decides which of the seven source types a document belongs to, and
// the two lookup tables (interval → hours, depth → what work it authorises).
//
// Why the seven types and not the five `category` values already on `documents`: the assignment
// asks for a policy per *kind of page*, and `category='site'` lumps together three kinds with
// wildly different economics — an undated "about us" page that must be re-checked hourly because
// the CEO trap lives on it (REPORT §2.2), a blog that gains ~17 posts a month and never edits the
// old ones, and quarterly reports/events. One knob for all three would either overpay for the
// blog or let the about page rot. So the classifier below splits `site` by URL shape and leaves
// the other four categories alone.
//
// What breaks if this is wrong: a document classified into the wrong type is refreshed on the
// wrong schedule and priced under the wrong line of the calculator. It is pure and unit-tested
// (`policy.test.ts`) for exactly that reason.

/** The seven source types the policy is expressed in. Order is the display order in the UI. */
export const SOURCE_TYPES = [
  "live_pages",
  "blog",
  "docs",
  "reports_events",
  "github",
  "video",
  "press",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** Re-check interval. `never` is a real choice, not a disabled state: ASR transcripts of 2021
 *  interviews genuinely do not change, and paying to check them is worse than not knowing. */
export const INTERVALS = ["hourly", "daily", "weekly", "monthly", "never"] as const;
export type Interval = (typeof INTERVALS)[number];

/**
 * How much work a detected change authorises.
 *
 *  · `check`   — run the three sieves, store the new text and log the change. The index is NOT
 *                rebuilt, so the change is *known* but not yet *searchable*; the run log marks
 *                such documents `index_stale`. Cheapest possible: no model call, no embedding.
 *  · `reindex` — re-chunk and re-embed the changed document (embedding money, no LLM).
 *  · `refacts` — `reindex` plus re-run the fact extractor on the changed document. The only depth
 *                that can notice that a *fact* changed value ("CEO: Kinitsky → Vasylchuk"), which
 *                is why it is the expensive one and why it is set per type rather than globally.
 */
export const DEPTHS = ["check", "reindex", "refacts"] as const;
export type Depth = (typeof DEPTHS)[number];

/** Ordering, so "does this depth authorise re-embedding?" is a comparison and not a switch. */
const DEPTH_RANK: Record<Depth, number> = { check: 0, reindex: 1, refacts: 2 };
export const depthAtLeast = (depth: Depth, minimum: Depth) => DEPTH_RANK[depth] >= DEPTH_RANK[minimum];

/** One type's settings. This is the object the UI's dropdown + toggle pair writes. */
export interface TypePolicy {
  interval: Interval;
  depth: Depth;
}

/** A complete policy: every source type has an entry. */
export type FreshnessPolicy = Record<SourceType, TypePolicy>;

/**
 * Hours between two checks of the same document.
 *
 * A month is 730 hours (365.25 × 24 ÷ 12), not 720: using 30 days would report 24.33 daily runs a
 * month and undercount the yearly bill by a day and a half of checking. `never` is Infinity so
 * that `730 / hours` is exactly 0 runs and `staleness = hours` is exactly "unbounded".
 */
export const INTERVAL_HOURS: Record<Interval, number> = {
  hourly: 1,
  daily: 24,
  weekly: 168,
  monthly: 730,
  never: Infinity,
};

/** Average hours in a calendar month. Every "per month" figure in the calculator uses this. */
export const HOURS_PER_MONTH = 730;

/** How many times a month a type is checked. 0 for `never`. */
export function runsPerMonth(interval: Interval): number {
  const hours = INTERVAL_HOURS[interval];
  return Number.isFinite(hours) ? HOURS_PER_MONTH / hours : 0;
}

/**
 * Worst-case staleness in hours: the longest a change can sit unnoticed.
 *
 * It is the interval itself, not half of it. Half the interval is the *average* delay; the
 * operator choosing a policy needs the guarantee, and the guarantee is "a change made one minute
 * after a check waits a full interval". `never` is Infinity, printed as "unbounded" in the UI.
 */
export const worstCaseStalenessHours = (interval: Interval) => INTERVAL_HOURS[interval];

/** Human labels, used by the UI and by the run log so both name a type the same way. */
export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  live_pages: "Live pages",
  blog: "Blog",
  docs: "Docs",
  reports_events: "Reports & events",
  github: "GitHub",
  video: "Video",
  press: "Press & third-party",
};

/** One line of plain English per type, shown under the label in the UI. */
export const SOURCE_TYPE_BLURBS: Record<SourceType, string> = {
  live_pages: "About, team, products, /mcp, ai-info — undated pages that describe the present.",
  blog: "everstake.com blog posts. New ones appear constantly; old ones are rarely edited.",
  docs: "docs.everstake.com, served as Markdown. Changes with product releases.",
  reports_events: "Quarterly reports, event pages and the press index on everstake.com.",
  github: "Public repo READMEs and the MCP tool list, checked through the GitHub API.",
  video: "YouTube auto-subtitles. A published transcript is never rewritten.",
  press: "Third-party coverage and profiles. New URLs appear; old articles stay put.",
};

/**
 * Which of the seven types a document belongs to.
 *
 * Four of the five crawler categories map one-to-one. `site` is split by URL, in this order:
 * reports/events and the press index first (they live under recognisable paths), then anything
 * with `/blog/` in it — both the current `/resources/blog/…` shape and the historical `/blog/…`
 * one left over from the domain migration — and whatever is left is a live page.
 *
 * Takes the URL and category rather than a row object so the tests can call it with literals and
 * so it can be applied to a URL that is not in the database yet (a newly discovered page).
 */
export function classifySourceType(url: string, category: string): SourceType {
  if (category === "code") return "github";
  if (category === "docs") return "docs";
  if (category === "video") return "video";
  if (category === "press") return "press";
  if (/\/resources\/(crypto-)?reports?\b|\/events?\b|\/company\/press\b/.test(url)) return "reports_events";
  if (/\/blog\//.test(url) || /\/blog$/.test(url)) return "blog";
  return "live_pages";
}

/** True when `policy` names every source type exactly once with valid values. Used to validate
 *  what arrives over HTTP before it is allowed anywhere near the scheduler. */
export function isCompletePolicy(policy: unknown): policy is FreshnessPolicy {
  if (!policy || typeof policy !== "object") return false;
  return SOURCE_TYPES.every((type) => {
    const entry = (policy as any)[type];
    return entry
      && (INTERVALS as readonly string[]).includes(entry.interval)
      && (DEPTHS as readonly string[]).includes(entry.depth);
  });
}

/**
 * Coerce an arbitrary object into a complete policy, filling gaps from `fallback`.
 *
 * The UI always sends all seven types, but `PUT /api/config` is a public endpoint and the
 * scheduler must never run against a half-policy: a missing type would silently become
 * "undefined interval", which `runsPerMonth` would turn into NaN and the refresher into
 * "everything is due, all the time".
 */
export function normalisePolicy(input: unknown, fallback: FreshnessPolicy): FreshnessPolicy {
  const out = {} as FreshnessPolicy;
  for (const type of SOURCE_TYPES) {
    const entry = (input as any)?.[type] ?? {};
    out[type] = {
      interval: (INTERVALS as readonly string[]).includes(entry.interval) ? entry.interval : fallback[type].interval,
      depth: (DEPTHS as readonly string[]).includes(entry.depth) ? entry.depth : fallback[type].depth,
    };
  }
  return out;
}
