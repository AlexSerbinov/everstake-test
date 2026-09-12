// Characterization tests for the shared primitives in src/util.ts. Everything downstream
// (hashing, shingling, date extraction, instruction splitting, cost printing) is built on
// these, so their exact edge behaviour is pinned here rather than rediscovered later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween, domainOf, estTokens, fmtUsd, isoDateOnly, normalizeText, pick, sentences, sha1 } from "./util.js";

test("normalizeText lowercases, drops punctuation and collapses whitespace to single spaces", () => {
  assert.equal(normalizeText("  Everstake's  130+ Networks!\n\nStaking. "), "everstake s 130 networks staking");
  // punctuation becomes a space, it does not glue neighbouring words together — otherwise
  // "state-of-the-art" and "stateoftheart" would shingle to different sets for no reason
  assert.equal(normalizeText("state-of-the-art"), "state of the art");
  assert.equal(normalizeText("héllo Ünicode 42"), "héllo ünicode 42");
  assert.equal(normalizeText("   "), "");
});

test("sha1 is the plain hex digest of the exact string it is given", () => {
  assert.equal(sha1(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(sha1("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.notEqual(sha1("Everstake"), sha1("everstake"), "sha1 is case-sensitive; normalizeText is what makes hashing case-insensitive");
});

test("domainOf strips the www prefix only, and returns an empty string for a non-URL", () => {
  assert.equal(domainOf("https://WWW.Everstake.com/resources/blog/x"), "everstake.com");
  assert.equal(domainOf("https://docs.everstake.com/"), "docs.everstake.com");
  assert.equal(domainOf("https://wwwx.everstake.com/"), "wwwx.everstake.com", "only the literal 'www.' label is stripped");
  assert.equal(domainOf("not a url"), "");
  assert.equal(domainOf(""), "");
});

test("isoDateOnly accepts anything Date can parse but rejects years outside 2015-2030", () => {
  assert.equal(isoDateOnly("2026-09-11T12:00:00Z"), "2026-09-11");
  assert.equal(isoDateOnly("Wed, 21 Oct 2026 07:28:00 GMT"), "2026-10-21", "an HTTP Last-Modified header");
  // the year window is the corpus sanity filter: a 1970 epoch default or a 2013 template date
  // must not become a publication date and win the recency ranking
  assert.equal(isoDateOnly("2014-12-31"), null);
  assert.equal(isoDateOnly("2015-01-01"), "2015-01-01");
  assert.equal(isoDateOnly("2030-12-31"), "2030-12-31");
  assert.equal(isoDateOnly("2031-01-01"), null);
  assert.equal(isoDateOnly("nonsense"), null);
  assert.equal(isoDateOnly(null), null);
  assert.equal(isoDateOnly(undefined), null);
  assert.equal(isoDateOnly(""), null);
});

test("isoDateOnly converts to UTC first, so a late-evening local timestamp can roll to the next day", () => {
  assert.equal(isoDateOnly("2026-09-11T23:30:00-05:00"), "2026-09-12");
  assert.equal(isoDateOnly("2026-09-11T01:30:00+05:00"), "2026-09-10");
});

test("daysBetween is absolute and counts fractional days", () => {
  assert.equal(daysBetween("2026-09-11", "2026-09-01"), 10);
  assert.equal(daysBetween("2026-09-01", "2026-09-11"), 10, "order does not matter");
  assert.equal(daysBetween("2026-09-01T00:00:00Z", "2026-09-01T12:00:00Z"), 0.5);
});

test("sentences splits only where a terminator is followed by an opening-looking token", () => {
  assert.deepEqual(sentences("Everstake was founded in 2018. It supports 130+ networks."),
    ["Everstake was founded in 2018.", "It supports 130+ networks."]);
  assert.deepEqual(sentences('He said "yes". "Then we ship."'), ['He said "yes".', '"Then we ship."']);
  // a lower-case continuation is NOT a boundary — this is what keeps "v1.5 of the sdk" in one piece
  assert.deepEqual(sentences("Release v1. 5 shipped"), ["Release v1. 5 shipped"]);
  assert.deepEqual(sentences(""), []);
});

test("estTokens is the chars/4 ceiling used for chunk sizing only", () => {
  assert.equal(estTokens(""), 0);
  assert.equal(estTokens("abc"), 1);
  assert.equal(estTokens("abcd"), 1);
  assert.equal(estTokens("abcde"), 2);
});

test("fmtUsd switches to 5 decimals strictly below one cent", () => {
  assert.equal(fmtUsd(0.009999), "$0.01000", "rounds up in the 5-decimal branch, it does not switch branch");
  assert.equal(fmtUsd(0.01), "$0.010");
  assert.equal(fmtUsd(1.2345), "$1.234", "toFixed rounds to even-ish binary, 1.2345 prints as 1.234");
  assert.equal(fmtUsd(0), "$0.00000");
});

test("pick is a head slice and never throws on a short array", () => {
  assert.deepEqual(pick([1, 2, 3], 2), [1, 2]);
  assert.deepEqual(pick([1], 5), [1]);
  assert.deepEqual(pick([], 3), []);
});
