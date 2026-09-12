// canonicalKey is the cheapest dedup sieve — two documents with the same key become one.
// core.test.ts pins the headline rules; this file pins the edges that decide whether a real
// crawl collapses a pair or keeps two copies of the same page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, isSoftRoot } from "./canon.js";

test("only the listed tracking parameters are dropped, the rest survive in their original order", () => {
  assert.equal(
    canonicalKey("https://everstake.com/resources/blog/x?page=2&utm_source=t&ref=a&referrer=b&source=c&mc_cid=1&q=keep"),
    "everstake.com/resources/blog/x?page=2&referrer=b&q=keep");
  // `ref` and `source` are anchored ($), so a longer name that merely starts the same is kept
  assert.equal(canonicalKey("https://a.com/p?ref=x"), "a.com/p");
  assert.equal(canonicalKey("https://a.com/p?referrer=x"), "a.com/p?referrer=x");
  assert.equal(canonicalKey("https://a.com/p?source=x"), "a.com/p");
  assert.equal(canonicalKey("https://a.com/p?sourceid=x"), "a.com/p?sourceid=x");
  // utm_ and mc_ are prefixes, so every member of those families goes
  assert.equal(canonicalKey("https://a.com/p?utm_medium=x&mc_eid=y"), "a.com/p");
});

test("the .one → .com rewrite covers subdomains, but the /blog/ rewrite is apex-only", () => {
  assert.equal(canonicalKey("https://EVERSTAKE.ONE/blog/post-1#anchor"), "everstake.com/resources/blog/post-1");
  assert.equal(canonicalKey("https://docs.everstake.one/guide/"), "docs.everstake.com/guide");
  // a blog subdomain keeps its /blog/ path — the rewrite is guarded on hostname === everstake.com
  assert.equal(canonicalKey("https://blog.everstake.one/blog/x"), "blog.everstake.com/blog/x");
  assert.equal(canonicalKey("https://other.com/blog/post"), "other.com/blog/post");
  // only the FIRST /blog/ segment is rewritten (the regex is anchored at the path start)
  assert.equal(canonicalKey("https://everstake.com/blog/x/blog/y"), "everstake.com/resources/blog/x/blog/y");
});

test("a site root normalises to a bare slash and .md is stripped only at the end of the path", () => {
  assert.equal(canonicalKey("https://everstake.com"), "everstake.com/");
  assert.equal(canonicalKey("https://everstake.com/"), "everstake.com/");
  assert.equal(canonicalKey("https://everstake.com/a/b.md?x=1"), "everstake.com/a/b?x=1");
  assert.equal(canonicalKey("https://everstake.com/a.md/b"), "everstake.com/a.md/b");
});

test("only TRAILING slashes are collapsed — a doubled internal slash still makes a second key", () => {
  // suspected bug, pinned as-is: https://everstake.com//about and /about are the same page for
  // the server but two different documents for the URL sieve
  assert.equal(canonicalKey("https://everstake.com///about///"), "everstake.com///about");
  assert.notEqual(canonicalKey("https://everstake.com//about"), canonicalKey("https://everstake.com/about"));
});

test("an unparseable URL falls back to its trimmed lower-cased self instead of throwing", () => {
  assert.equal(canonicalKey("  Not A URL  "), "not a url");
  assert.equal(canonicalKey(""), "");
});

test("soft-404 detection needs the canonical root to be on the same host as the final URL", () => {
  // a legitimate cross-site canonical (syndicated post pointing at the publisher's home page)
  // must not be mistaken for a redirect to the site root
  assert.equal(isSoftRoot("https://a.com/post", "https://a.com/post", "https://b.com/"), false);
  assert.equal(isSoftRoot("https://a.com/post", "https://a.com/post", "https://a.com/"), true);
  // a seed that IS the root can never be a soft-404 — there is no path to lose
  assert.equal(isSoftRoot("https://a.com", "https://a.com/x", null), false);
  assert.equal(isSoftRoot("https://a.com/post/", "https://a.com", null), true, "a trailing slash on the final URL is still the root");
});
