// robots.txt is the one place where a parsing mistake turns into a politeness incident.
// `parse` is private, so the rules are pinned through `robotsFor` with a stubbed fetch —
// no network, one host per scenario (results are cached per origin for the whole process).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, robotsFor } from "./robots.js";

let host = 0;
/** Serve `txt` (or a status / a thrown network error) as robots.txt for a fresh origin. */
async function rulesFor(txt: string | { status: number } | { throws: true }) {
  const origin = `https://h${++host}.test`;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    assert.equal(String(input), `${origin}/robots.txt`, "robotsFor must ask for /robots.txt at the origin and nothing else");
    if (typeof txt === "object" && "throws" in txt) throw new Error("ECONNREFUSED");
    if (typeof txt === "object") return new Response("", { status: txt.status });
    return new Response(txt, { status: 200 });
  }) as typeof fetch;
  try { return { rules: await robotsFor(`${origin}/`), origin }; } finally { globalThis.fetch = real; }
}

test("the longest matching pattern wins and a tie goes to Allow", async () => {
  const { rules, origin } = await rulesFor("User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /a\nAllow: /a\n");
  assert.equal(isAllowed(rules, `${origin}/`), true, "no Disallow matches → allowed");
  assert.equal(isAllowed(rules, `${origin}/private/x`), false);
  assert.equal(isAllowed(rules, `${origin}/private/public/x`), true, "the longer Allow overrides the shorter Disallow");
  assert.equal(isAllowed(rules, `${origin}/a`), true, "equal length → Allow");
});

test("* expands to any run of characters and a trailing $ anchors the end of the path", async () => {
  const { rules, origin } = await rulesFor("User-agent: *\nDisallow: /*.pdf$\nDisallow: /x/*/secret\n");
  assert.equal(isAllowed(rules, `${origin}/docs/report.pdf`), false);
  assert.equal(isAllowed(rules, `${origin}/docs/report.pdf?v=2`), true, "$ anchors, and the query string is part of the matched path");
  assert.equal(isAllowed(rules, `${origin}/x/any/thing/secret/deep`), false);
  assert.equal(isAllowed(rules, `${origin}/x/secret`), true, "the * needs at least the two slashes around it");
});

test("a query string is matched as part of the path, so ?print= can be disallowed on its own", async () => {
  const { rules, origin } = await rulesFor("User-agent: *\nDisallow: /page?print\n");
  assert.equal(isAllowed(rules, `${origin}/page`), true);
  assert.equal(isAllowed(rules, `${origin}/page?print=1`), false);
});

test("a group naming our user agent replaces the wildcard group instead of adding to it", async () => {
  const { rules, origin } = await rulesFor("User-agent: *\nDisallow: /\n\nUser-agent: EverstakeKB\nDisallow: /admin/\n");
  assert.equal(isAllowed(rules, `${origin}/anything`), true, "the * group is ignored once a named group matches");
  assert.equal(isAllowed(rules, `${origin}/admin/x`), false);
});

// suspected bug, pinned as-is: the UA test is `ua.startsWith(agent)`, so a group written for a
// completely different crawler whose name is a prefix of ours captures us
test("user-agent matching is a loose prefix test, so a shorter unrelated token still claims us", async () => {
  const { rules, origin } = await rulesFor("User-agent: *\nAllow: /\n\nUser-agent: Ever\nDisallow: /\n");
  assert.equal(isAllowed(rules, `${origin}/anything`), false, "'Ever' is a prefix of 'everstakekb' and wins the group choice");
  const other = await rulesFor("User-agent: *\nAllow: /\n\nUser-agent: EverstakeKB-Images\nDisallow: /\n");
  assert.equal(isAllowed(other.rules, `${other.origin}/anything`), true, "a LONGER name is not a prefix of ours, so it is correctly skipped");
});

test("consecutive User-agent lines share one group, a non-agent line closes it", async () => {
  const { rules, origin } = await rulesFor("User-agent: GPTBot\nUser-agent: EverstakeKB\nDisallow: /shared/\n\nUser-agent: OtherBot\nDisallow: /\n");
  assert.equal(isAllowed(rules, `${origin}/shared/x`), false);
  assert.equal(isAllowed(rules, `${origin}/elsewhere`), true, "OtherBot's group is not ours");
});

test("an empty Disallow means 'nothing is disallowed' and does not become a rule", async () => {
  const { rules, origin } = await rulesFor("User-agent: *\nDisallow:\n");
  assert.deepEqual(rules.disallow, []);
  assert.equal(isAllowed(rules, `${origin}/anything`), true);
});

test("comments, blank lines and unparseable lines are skipped without breaking the group", async () => {
  const { rules, origin } = await rulesFor("# a comment\n\nUser-agent: *   # inline\n  Disallow: /private/  # trailing\nthis line has no colon\nSitemap: https://x.test/sitemap.xml\nDisallow: /also/\n");
  assert.deepEqual(rules.disallow, ["/private/", "/also/"]);
  assert.equal(isAllowed(rules, `${origin}/also/x`), false);
});

test("directives before any User-agent line belong to no group and are discarded", async () => {
  const { rules, origin } = await rulesFor("Disallow: /orphan/\nUser-agent: *\nDisallow: /real/\n");
  assert.deepEqual(rules.disallow, ["/real/"]);
  assert.equal(isAllowed(rules, `${origin}/orphan/x`), true);
});

test("Crawl-delay is seconds → milliseconds, the largest applicable group wins, and 0 is ignored", async () => {
  const a = await rulesFor("User-agent: *\nCrawl-delay: 2\n");
  assert.equal(a.rules.crawlDelayMs, 2000);
  const b = await rulesFor("User-agent: EverstakeKB\nCrawl-delay: 1\nUser-agent: Ever\nCrawl-delay: 5\n");
  assert.equal(b.rules.crawlDelayMs, 5000, "both groups match us; the delays are max()-ed, not overwritten");
  const c = await rulesFor("User-agent: *\nCrawl-delay: 0\n");
  assert.equal(c.rules.crawlDelayMs, null);
  const d = await rulesFor("User-agent: *\nCrawl-delay: soon\n");
  assert.equal(d.rules.crawlDelayMs, null);
});

// "unknown rules" must never mean "go ahead": a host that refuses to serve robots.txt is
// treated as fully disallowed, which is stricter than RFC 9309 requires for 5xx
test("403 and 5xx on robots.txt block the whole host, 404 leaves it fully allowed", async () => {
  const forbidden = await rulesFor({ status: 403 });
  assert.equal(forbidden.rules.blocked, true);
  assert.equal(isAllowed(forbidden.rules, `${forbidden.origin}/anything`), false);

  const down = await rulesFor({ status: 503 });
  assert.equal(isAllowed(down.rules, `${down.origin}/anything`), false);

  const missing = await rulesFor({ status: 404 });
  assert.deepEqual([missing.rules.blocked, missing.rules.fetched], [false, true]);
  assert.equal(isAllowed(missing.rules, `${missing.origin}/anything`), true, "no robots.txt → no rules → allowed");
});

test("a network error is recorded as not-fetched and falls back to allowed", async () => {
  const { rules, origin } = await rulesFor({ throws: true });
  assert.deepEqual([rules.fetched, rules.blocked], [false, false]);
  assert.equal(isAllowed(rules, `${origin}/anything`), true);
});

test("rules are fetched once per origin and reused from cache afterwards", async () => {
  const { origin } = await rulesFor("User-agent: *\nDisallow: /cached/\n");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("robots.txt must not be fetched twice for the same origin"); }) as typeof fetch;
  try {
    const again = await robotsFor(`${origin}/some/other/page`);
    assert.deepEqual(again.disallow, ["/cached/"]);
  } finally { globalThis.fetch = real; }
});
