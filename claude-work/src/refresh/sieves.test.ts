// The three sieves' decisions, and the dueness rule that decides whether a document is even
// looked at. Pure functions, so this file needs no database and no network.
//
// These are the tests that protect the money. Every wrong "changed" verdict here is a document
// re-embedded and re-extracted for nothing, and every wrong "unchanged" verdict is a corpus that
// silently rots while the UI reports it as fresh — the CEO trap, back again. Both directions are
// asserted for each sieve.

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeText, sha1 } from "../util.js";
import { canRevalidate, conditionalValidators, isDue, lastmodVerdict, pushedAtVerdict, responseVerdict } from "./sieves.js";
import { classifySourceType, isCompletePolicy, normalisePolicy, type FreshnessPolicy } from "./policy.js";

// --- sieve 1: sitemap lastmod ------------------------------------------------------------------

test("lastmod: identical timestamps skip the document with no request at all", () => {
  const verdict = lastmodVerdict("2026-05-05", "2026-05-05");
  assert.equal(verdict.skip, true);
  assert.match(verdict.reason, /unchanged/);
});

test("lastmod: a moved timestamp does not skip, and the reason names both values", () => {
  const verdict = lastmodVerdict("2026-05-05", "2026-09-01");
  assert.equal(verdict.skip, false);
  assert.match(verdict.reason, /2026-05-05 → 2026-09-01/);
});

test("lastmod: no stored value and no observed value both fall through to the next sieve", () => {
  // First refresh after the initial crawl: nothing to compare against, so check properly.
  assert.equal(lastmodVerdict(null, "2026-09-01").skip, false);
  // The sitemap stopped listing the URL: absence is not evidence of freshness.
  assert.equal(lastmodVerdict("2026-05-05", null).skip, false);
  assert.equal(lastmodVerdict(null, null).skip, false);
});

test("lastmod: a timestamp that moved BACKWARDS is checked, not skipped", () => {
  // A CMS that rolls a timestamp back is misbehaving, and the safe reading of a misbehaving
  // signal is "look at the page", not "assume it is fine".
  assert.equal(lastmodVerdict("2026-09-01", "2026-05-05").skip, false);
});

// --- sieve 2: conditional GET --------------------------------------------------------------------

test("conditional GET: both validators are offered when both were stored", () => {
  const validators = conditionalValidators({ etag: 'W/"abc"', last_modified_header: "Wed, 01 Jan 2026 00:00:00 GMT" });
  assert.equal(validators.etag, 'W/"abc"');
  assert.equal(validators.lastModified, "Wed, 01 Jan 2026 00:00:00 GMT");
  assert.equal(canRevalidate({ etag: 'W/"abc"', last_modified_header: null }), true);
  assert.equal(canRevalidate({ etag: null, last_modified_header: null }), false);
});

test("304 is the server's own answer and is taken as authoritative — no hashing, no body", () => {
  const verdict = responseVerdict({ ok: true, status: 304, notModified: true }, null, "deadbeef");
  assert.equal(verdict.outcome, "not_modified");
  assert.equal(verdict.sieve, "conditional");
  assert.equal(verdict.hash, undefined);
});

test("a failed request is an error, never `unchanged`", () => {
  // "we could not check" and "we checked and nothing moved" must not collapse into one outcome,
  // or an origin that starts 403-ing looks like a perfectly fresh corpus.
  const verdict = responseVerdict({ ok: false, status: 403, error: "http 403" }, null, "deadbeef");
  assert.equal(verdict.outcome, "error");
  assert.match(verdict.reason, /403/);
});

test("a 200 with no extractable text is an error, not a change to empty", () => {
  const verdict = responseVerdict({ ok: true, status: 200 }, null, "deadbeef");
  assert.equal(verdict.outcome, "error");
});

// --- sieve 3: content hash ------------------------------------------------------------------------

test("hash: the same text hashes to the stored value and costs nothing further", () => {
  const text = "Everstake supports 130+ networks.";
  const stored = sha1(normalizeText(text));
  const verdict = responseVerdict({ ok: true, status: 200 }, text, stored);
  assert.equal(verdict.outcome, "unchanged");
  assert.equal(verdict.sieve, "hash");
  assert.equal(verdict.hash, stored);
});

test("hash: cosmetic differences are not changes, because the text is normalised first", () => {
  const stored = sha1(normalizeText("Everstake  supports 130+ networks."));
  const verdict = responseVerdict({ ok: true, status: 200 }, "Everstake supports 130+   networks.\n", stored);
  assert.equal(verdict.outcome, "unchanged");
});

test("hash: real new text is a change, and the reason shows both hash prefixes", () => {
  const stored = sha1(normalizeText("The CEO is David Kinitsky."));
  const verdict = responseVerdict({ ok: true, status: 200 }, "The CEO is Sergii Vasylchuk.", stored);
  assert.equal(verdict.outcome, "changed");
  assert.match(verdict.reason, /content hash [0-9a-f]{8} → [0-9a-f]{8}/);
});

test("hash: a document with no stored hash counts as changed, and says why", () => {
  const verdict = responseVerdict({ ok: true, status: 200 }, "anything", null);
  assert.equal(verdict.outcome, "changed");
  assert.match(verdict.reason, /no previous hash/);
});

test("a re-fetch that lost most of its text is refused, not stored as a change", () => {
  // The bug this exists for: the first real refresh fetched the YouTube documents (whose text
  // comes from yt-dlp, not from the watch page) over HTTP, extracted nothing from the JS shell,
  // and recorded twelve "changes" to the empty string — deleting twelve transcripts.
  const emptied = responseVerdict({ ok: true, status: 200 }, "", "abc123", 8400);
  assert.equal(emptied.outcome, "error");
  assert.match(emptied.reason, /0 characters back where 8400 were stored/);

  // A consent wall leaves a short page rather than an empty one; same verdict.
  const wall = responseVerdict({ ok: true, status: 200 }, "Please enable JavaScript to continue.", "abc123", 8400);
  assert.equal(wall.outcome, "error");

  // Half the page is the boundary, and it is allowed through: real edits do delete sections.
  const halved = responseVerdict({ ok: true, status: 200 }, "x".repeat(4200), "abc123", 8400);
  assert.equal(halved.outcome, "changed");

  // The guard needs a previous length to compare against; a document that never had one (the
  // first check after an import) must not be blocked by it.
  assert.equal(responseVerdict({ ok: true, status: 200 }, "short", "abc123", null).outcome, "changed");
  assert.equal(responseVerdict({ ok: true, status: 200 }, "short", "abc123", 0).outcome, "changed");
});

// --- GitHub's sieve --------------------------------------------------------------------------------

test("pushed_at behaves exactly like lastmod, including the two null cases", () => {
  assert.equal(pushedAtVerdict("2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z").skip, true);
  assert.equal(pushedAtVerdict("2026-09-01T10:00:00Z", "2026-09-02T11:00:00Z").skip, false);
  assert.equal(pushedAtVerdict(null, "2026-09-02T11:00:00Z").skip, false);
  assert.equal(pushedAtVerdict("2026-09-01T10:00:00Z", null).skip, false);
});

// --- dueness ------------------------------------------------------------------------------------

test("dueness: never checked is always due; `never` (Infinity hours) never is", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  assert.equal(isDue(null, 24, now), true);
  assert.equal(isDue(null, Infinity, now), false);
  assert.equal(isDue("2020-01-01T00:00:00Z", Infinity, now), false);
});

test("dueness: the boundary is inclusive — exactly one interval elapsed is due", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  assert.equal(isDue("2026-09-11T12:00:00Z", 24, now), true);
  assert.equal(isDue("2026-09-11T12:00:01Z", 24, now), false);
  assert.equal(isDue("2026-09-12T11:00:00Z", 1, now), true);
});

test("dueness: an unparsable stored timestamp is treated as due rather than as fresh forever", () => {
  assert.equal(isDue("not a date", 24, new Date("2026-09-12T12:00:00Z")), true);
});

// --- classification, which decides WHICH interval applies -------------------------------------------

test("classification maps the crawler's categories and splits `site` by URL shape", () => {
  assert.equal(classifySourceType("https://raw.githubusercontent.com/everstake/mcp/main/README.md", "code"), "github");
  assert.equal(classifySourceType("https://docs.everstake.com/api.md", "docs"), "docs");
  assert.equal(classifySourceType("https://www.youtube.com/watch?v=abc", "video"), "video");
  assert.equal(classifySourceType("https://chainwire.org/2025/06/12/x/", "press"), "press");

  assert.equal(classifySourceType("https://everstake.com/resources/blog/some-post", "site"), "blog");
  // The historical /blog/ shape left over from the everstake.one → .com migration.
  assert.equal(classifySourceType("https://everstake.com/blog/some-post", "site"), "blog");
  assert.equal(classifySourceType("https://everstake.com/resources/crypto-reports", "site"), "reports_events");
  assert.equal(classifySourceType("https://everstake.com/company/press", "site"), "reports_events");
  // The CEO trap lives here: an undated evergreen page that describes the present.
  assert.equal(classifySourceType("https://everstake.com/company/about", "site"), "live_pages");
  assert.equal(classifySourceType("https://everstake.com/ai-info", "site"), "live_pages");
});

// --- policy validation ------------------------------------------------------------------------------

test("an incomplete or invalid policy is filled in from the fallback rather than half-applied", () => {
  const fallback = {
    live_pages: { interval: "daily", depth: "refacts" }, blog: { interval: "daily", depth: "refacts" },
    docs: { interval: "weekly", depth: "reindex" }, reports_events: { interval: "weekly", depth: "refacts" },
    github: { interval: "daily", depth: "refacts" }, video: { interval: "monthly", depth: "reindex" },
    press: { interval: "weekly", depth: "check" },
  } as FreshnessPolicy;

  assert.equal(isCompletePolicy({ blog: { interval: "hourly", depth: "check" } }), false);
  assert.equal(isCompletePolicy(fallback), true);
  assert.equal(isCompletePolicy({ ...fallback, blog: { interval: "fortnightly", depth: "check" } }), false);

  // A partial patch keeps its own values and inherits the rest — a missing type must never
  // become `undefined`, which would make `runsPerMonth` NaN and everything permanently due.
  const merged = normalisePolicy({ blog: { interval: "hourly", depth: "check" }, docs: { interval: "nonsense", depth: "check" } }, fallback);
  assert.deepEqual(merged.blog, { interval: "hourly", depth: "check" });
  assert.deepEqual(merged.docs, { interval: "weekly", depth: "check" });
  assert.deepEqual(merged.video, fallback.video);
  assert.equal(isCompletePolicy(merged), true);
});
