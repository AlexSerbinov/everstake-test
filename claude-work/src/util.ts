// Shared primitives with no dependency on the database, the config or a provider.
// They sit under every stage of the pipeline (crawl → dedup → index → facts → retrieve →
// answer → eval), which is why they live in one leaf module: `util.ts` imports nothing from
// the project, so nothing here can create an import cycle.
//
// What breaks if these are wrong: `normalizeText`+`sha1` decide which documents are byte
// duplicates, `isoDateOnly` decides what counts as a publication date (and therefore the
// recency ranking), and `sentences` decides where an injected instruction starts and ends.
// A silent change here shifts results in every later stage at once, so every edge case is
// pinned in `util.test.ts`.

import crypto from "node:crypto";

// Publication dates outside this window are template junk, not real dates: a Unix-epoch
// default renders as 1970, and abandoned CMS themes ship 2013-ish placeholder dates. Both
// would otherwise win or lose the recency ranking for the wrong reason.
const MIN_PLAUSIBLE_YEAR = 2015;
const MAX_PLAUSIBLE_YEAR = 2030;

const MS_PER_DAY = 86_400_000;

// The chars-per-token divisor behind `estTokens`. 4 is the usual rule of thumb for English
// prose in a BPE tokenizer; it is not measured here and is wrong by roughly ±25% on code,
// URLs and non-Latin text. Only ever used where being off by a quarter is harmless.
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Below one cent, three decimals print as "$0.000" and lose the number entirely, so the
// formatter widens instead of rounding a real cost away.
const SUB_CENT_THRESHOLD_USD = 0.01;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Content fingerprint. sha1 (not sha256) because this is a dedup key, never a security
 * boundary: an attacker cannot supply both sides of a collision here, and the shorter
 * digest keeps the `documents.content_hash` index small.
 */
export const sha1 = (text: string) => crypto.createHash("sha1").update(text).digest("hex");

/**
 * Canonical form for comparing two texts. Case, punctuation and whitespace are the three
 * things a CMS changes without changing the content, so they are removed before hashing
 * (exact dedup) and before shingling (MinHash near-dedup).
 * Punctuation collapses to a SPACE, not to nothing: "state-of-the-art" and "state of the
 * art" must produce the same shingles, and gluing them into "stateoftheart" would not.
 */
export function normalizeText(text: string): string {
  // \p{L}\p{N} with the u flag keeps accented and non-Latin letters — the corpus has
  // Ukrainian and German pages, and stripping them would make those documents hash alike.
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Registrable-ish host used as the source-authority and same-domain-dedup key.
 * Only the literal `www.` label is stripped: `docs.everstake.com` is a genuinely different
 * source tier from `everstake.com` and must stay distinct.
 * Returns "" rather than throwing, because crawl inputs include sitemap junk that is not a URL.
 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Rough token count from character length. Safe for capacity decisions that have slack —
 * chunk sizing, deciding whether a prompt is obviously too big — and NOT safe for anything
 * that is reported or billed: every cost figure in the report comes from provider-reported
 * usage in `llm_calls`, never from this function (see REPORT.md §3).
 * Currently referenced only by its characterization test; kept because it is the intended
 * answer to "how many tokens is this roughly" and removing it invites a worse ad-hoc one.
 */
export const estTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);

/**
 * Parse any date-ish string a page can offer (ISO, an HTTP `Last-Modified` header, JSON-LD)
 * down to a bare `YYYY-MM-DD`, or null when it is unusable.
 * Day granularity is deliberate: nothing downstream ranks by hour, and storing a full
 * timestamp would make two records of the same publication look different.
 */
export function isoDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Compared in UTC, so an evening-in-New-York timestamp is filed under the next UTC day.
  // Consistency matters more than local correctness: every other date in the corpus is UTC.
  const year = date.getUTCFullYear();
  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  return date.toISOString().slice(0, 10);
}

/** Absolute distance in (fractional) days — the input to recency decay. Order-independent
 *  so callers never have to know which of the two dates is older. */
export function daysBetween(isoA: string, isoB: string) {
  return Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / MS_PER_DAY;
}

/**
 * Sentence split good enough for instruction detection — a full NLP splitter is not worth a
 * dependency here, and over-splitting is the only failure that hurts (an injected sentence
 * cut in half would be removed only in part).
 * The lookbehind/lookahead pair means "a terminator followed by whitespace and then
 * something that looks like the start of a sentence": a capital, a quote or a bracket.
 * So `Founded in 2018. It supports…` splits, while `Release v1. 5 shipped` does not.
 */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"“(\[])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Head slice that tolerates `count` larger than the array, so callers can pass a config
 *  top-k straight in without a length check. */
export function pick<T>(items: T[], count: number): T[] {
  return items.slice(0, count);
}

/**
 * USD for humans. Per-call costs in this system are routinely $0.00001-$0.05, so a fixed
 * precision either prints "$0.000" for a real charge or "$1.20000" for a total. The
 * threshold is on the value, not on the rounded output: $0.009999 still takes the 5-decimal
 * branch and prints "$0.01000".
 */
export function fmtUsd(amountUsd: number) {
  return amountUsd < SUB_CENT_THRESHOLD_USD ? `$${amountUsd.toFixed(5)}` : `$${amountUsd.toFixed(3)}`;
}
