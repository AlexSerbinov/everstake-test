// The three cheap sieves the refresh runs before it is allowed to spend anything, and nothing
// else. Every function here is pure: it takes what was stored last time plus what was observed
// this time and returns a decision. The runner (refresh.ts) does the I/O and obeys them.
//
// The order is the whole economy of the thing, cheapest first:
//
//   1. sitemap `lastmod`   — 0 HTTP requests for this document. One sitemap fetch settles 336
//                            pages at once. If lastmod has not moved since the value we stored,
//                            the page is unchanged and we never touch it.
//   2. conditional GET     — 1 request, no body. `If-None-Match` / `If-Modified-Since` built
//                            from the ETag and Last-Modified we stored at the last fetch. A 304
//                            costs a few hundred bytes and no parsing.
//   3. content hash        — the body did come back, but sha1 of the normalised text is the one
//                            we already have. Common: a page whose only diff is a rotating
//                            banner, a view counter or a rebuilt asset URL. Nothing is reindexed.
//
// Only a document that survives all three is expensive, and only then does `depth` decide how
// expensive. On this corpus the first sieve alone is expected to settle the large majority of
// the 442 documents, which is the difference between $0.4 and $2.2 a month.
//
// Why `lastmod` is trusted HERE when REPORT §2.2 says it must never be a publication date: those
// are different claims. "This page was edited at T" is exactly what a CMS timestamp is good for;
// "this page was written at T" is what it is not. The domain migration re-stamped 156 old posts
// — as a publication date that was a lie, as a change signal it was correct, because the pages
// really had just been rewritten onto a new domain.

import { normalizeText, sha1 } from "../util.js";

/** Which sieve produced a verdict. Recorded on every change-log row so a run can be audited. */
export type SieveName = "lastmod" | "conditional" | "hash" | "pushed_at" | "none";

/** What sieve 1 concluded. `unknown` means the sitemap has nothing to say and sieve 2 must run. */
export type LastmodVerdict =
  | { skip: true; sieve: "lastmod"; reason: string }
  | { skip: false; reason: string };

/**
 * Sieve 1. Compare the `<lastmod>` this run read from the sitemap against the one stored when the
 * document was last checked.
 *
 * Skips only on a strict equality of two present values. Three cases deliberately do NOT skip:
 *  · we have no stored lastmod (first refresh after the initial crawl — nothing to compare to);
 *  · the sitemap does not list this URL (`observed` null — it may have been dropped or renamed);
 *  · the stored value is newer than the observed one (a CMS that rolled a timestamp back is
 *    misbehaving, and the safe reading of a misbehaving signal is "check properly").
 *
 * String comparison, not Date parsing: sitemap timestamps here are ISO-8601 and compare correctly
 * as strings, and a value we cannot parse should fall through to sieve 2 rather than become
 * `Invalid Date`, which compares equal to nothing and would silently re-fetch the world.
 */
export function lastmodVerdict(stored: string | null | undefined, observed: string | null | undefined): LastmodVerdict {
  if (!observed) return { skip: false, reason: "not listed in the sitemap this run" };
  if (!stored) return { skip: false, reason: "no lastmod stored from the previous check" };
  if (stored === observed) return { skip: true, sieve: "lastmod", reason: `sitemap lastmod unchanged (${observed})` };
  return { skip: false, reason: `sitemap lastmod moved ${stored} → ${observed}` };
}

/** Sieve 2's request half: what to offer the server so it may answer 304. */
export function conditionalValidators(doc: { etag?: string | null; last_modified_header?: string | null }) {
  return { etag: doc.etag ?? null, lastModified: doc.last_modified_header ?? null };
}

/** True when we hold at least one validator, i.e. a 304 is even possible. A document with
 *  neither gets an ordinary GET and is settled by sieve 3 instead. */
export const canRevalidate = (doc: { etag?: string | null; last_modified_header?: string | null }) =>
  Boolean(doc.etag || doc.last_modified_header);

/**
 * A re-fetch that comes back with a small fraction of the text we had is treated as a failure to
 * check, not as a change.
 *
 * This is not hypothetical: the first real refresh run against this corpus fetched the twelve
 * YouTube documents over plain HTTP (their text comes from yt-dlp subtitles, not from the watch
 * page), extracted zero characters from the JS shell, and duly recorded twelve "changes" to the
 * empty string — deleting twelve transcripts and their chunks. A consent wall, a Cloudflare
 * interstitial or an origin that starts serving a client-rendered shell all look exactly the
 * same. Losing content is the one refresh outcome that is not self-correcting, so the shape of
 * the new text is checked before it is allowed to replace the old.
 *
 * 0.5 is a judgement, not a measurement: a real edit that halves a page is rare, and an
 * interstitial that leaves half the text is rarer still.
 */
const MIN_RETAINED_TEXT_FRACTION = 0.5;

/** Below this the new text is not a page at all, whatever the old length was. */
const MIN_PLAUSIBLE_TEXT_CHARS = 120;

/** What happened to one document this run. Ordered from cheapest to most expensive outcome. */
export type Outcome = "not_modified" | "unchanged" | "changed" | "error";

export interface ResponseVerdict {
  outcome: Outcome;
  sieve: SieveName;
  reason: string;
  /** sha1 of the normalised text, when a body was read. Stored on the document when it changed. */
  hash?: string;
}

/**
 * Sieves 2 and 3, over one HTTP response.
 *
 * `notModified` is the server's own answer and is taken as authoritative — that is the point of
 * a validator. Otherwise the body is hashed the same way the crawler hashes it (`sha1` of
 * `normalizeText`), so a page that only changed its whitespace or casing is recognised as
 * unchanged, and the hash stored by the original crawl is directly comparable.
 *
 * A failed request is an `error` outcome, never `unchanged`: "we could not check" and "we
 * checked and nothing moved" must not collapse into the same log line, or an origin that starts
 * 403-ing us looks like a perfectly fresh corpus.
 */
export function responseVerdict(
  response: { ok: boolean; status: number; notModified?: boolean; error?: string },
  newText: string | null,
  storedHash: string | null | undefined,
  previousChars: number | null = null,
): ResponseVerdict {
  if (response.notModified) {
    return { outcome: "not_modified", sieve: "conditional", reason: "304 Not Modified" };
  }
  if (!response.ok) {
    return { outcome: "error", sieve: "none", reason: response.error ?? `http ${response.status}` };
  }
  if (newText === null) {
    return { outcome: "error", sieve: "none", reason: "no text could be extracted from the response" };
  }
  // The shrink guard, before the hash: an emptied page hashes perfectly well.
  if (previousChars && previousChars > 0) {
    if (newText.length < MIN_PLAUSIBLE_TEXT_CHARS || newText.length < previousChars * MIN_RETAINED_TEXT_FRACTION) {
      return {
        outcome: "error",
        sieve: "none",
        reason: `refused: ${newText.length} characters back where ${previousChars} were stored `
          + `(a wall, a client-rendered shell or the wrong fetcher for this source) — the document was left as it was`,
      };
    }
  }

  const hash = sha1(normalizeText(newText));
  if (storedHash && hash === storedHash) {
    return { outcome: "unchanged", sieve: "hash", reason: "content hash identical", hash };
  }
  return {
    outcome: "changed",
    sieve: "hash",
    reason: storedHash ? `content hash ${storedHash.slice(0, 8)} → ${hash.slice(0, 8)}` : "no previous hash stored",
    hash,
  };
}

/**
 * Sieve 1 for GitHub, which has no sitemap but has something better: one call to
 * `GET /orgs/{org}/repos` returns `pushed_at` for every repo in the org, so 11 documents are
 * settled by one request. Same rule as `lastmodVerdict` — skip only on an exact match of two
 * present values.
 */
export function pushedAtVerdict(stored: string | null | undefined, observed: string | null | undefined): LastmodVerdict {
  if (!observed) return { skip: false, reason: "repo not present in the org listing" };
  if (!stored) return { skip: false, reason: "no pushed_at stored from the previous check" };
  if (stored === observed) return { skip: true, sieve: "lastmod", reason: `pushed_at unchanged (${observed})` };
  return { skip: false, reason: `pushed_at moved ${stored} → ${observed}` };
}

/**
 * Is this document due, given when it was last checked and how many hours its type's interval
 * allows between checks?
 *
 * `never` arrives here as `Infinity` and is never due. A document that has never been checked is
 * always due — after the initial crawl every document is in that state, which is why the first
 * refresh run is the expensive one and every run after it is not.
 */
export function isDue(lastCheckedAt: string | null | undefined, intervalHours: number, now: Date): boolean {
  if (!Number.isFinite(intervalHours)) return false;
  if (!lastCheckedAt) return true;
  const elapsedHours = (now.getTime() - Date.parse(lastCheckedAt)) / 3_600_000;
  // NaN (an unparsable stored timestamp) fails this comparison, so the document is treated as
  // due — checking a page we cannot date is cheap; skipping it forever is not.
  return !(elapsedHours < intervalHours);
}
