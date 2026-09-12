// HTML → text and, more importantly, HTML → publication date. The date drives the recency
// multiplier in ranking, so which signal wins is a ranking decision, not a parsing detail.
// core.test.ts already pins malformedNumbers on the two headline cases; the rest is here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, extractHtml, extractMarkdown, malformedNumbers } from "./extract.js";

/** 300+ chars of body text, so <article>/<main> clears the length threshold. */
const body = (s: string) => (s + " ").repeat(20);

test("date priority: article:published_time wins, then JSON-LD, then <time>, then Last-Modified", () => {
  const head = (extra: string) => `<html><head><title>T</title>${extra}</head><body><main><p>${body("Content.")}</p><time datetime="2020-01-01">shown</time></main></body></html>`;
  const meta = `<meta property="article:published_time" content="2026-05-05T00:00:00Z">`;
  const ld = `<script type="application/ld+json">{"@type":"Article","datePublished":"2026-03-04T10:00:00Z"}</script>`;

  const a = extractHtml(head(meta + ld), "https://x.com/a", "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.deepEqual([a.publishedAt, a.dateSource], ["2026-05-05", "article:published_time"]);

  const b = extractHtml(head(ld), "https://x.com/a", "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.deepEqual([b.publishedAt, b.dateSource], ["2026-03-04", "json-ld:datePublished"]);

  const c = extractHtml(head(""), "https://x.com/a", "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.deepEqual([c.publishedAt, c.dateSource], ["2020-01-01", "time[datetime]"], "the first <time datetime> inside the chosen root");

  const d = extractHtml(`<html><head><title>T</title></head><body><p>hi</p></body></html>`, "https://x.com/a", "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.deepEqual([d.publishedAt, d.dateSource], ["2026-10-21", "last-modified"]);

  const e = extractHtml(`<html><head><title>T</title></head><body><p>hi</p></body></html>`, "https://x.com/a", null);
  assert.deepEqual([e.publishedAt, e.dateSource], [null, null]);
});

// the corpus survey found 2013-era template dates in meta tags; isoDateOnly's year window
// rejects them, and the extractor must then FALL THROUGH rather than give up on the date
test("a date outside the sane year window is skipped and the next signal is used", () => {
  const html = `<html><head><title>T</title>
    <meta property="article:published_time" content="2013-05-05T00:00:00Z">
    <script type="application/ld+json">{"datePublished":"2026-03-04T10:00:00Z"}</script>
    </head><body><main><p>${body("Content.")}</p></main></body></html>`;
  const r = extractHtml(html, "https://x.com/a", null);
  assert.deepEqual([r.publishedAt, r.dateSource], ["2026-03-04", "json-ld:datePublished"]);
});

test("broken JSON-LD is ignored rather than fatal, and datePublished is found at any nesting depth", () => {
  const broken = `<script type="application/ld+json">{ this is not json }</script>`;
  const nested = `<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Article","datePublished":"2026-01-09"}]}</script>`;
  const r = extractHtml(`<html><head><title>T</title>${broken}${nested}</head><body><p>hi</p></body></html>`, "https://x.com/a", null);
  assert.deepEqual([r.publishedAt, r.dateSource], ["2026-01-09", "json-ld:datePublished"]);
});

// suspected bug, pinned as-is: with only a Last-Modified header and an article:modified_time,
// publishedAt (from the header) ends up LATER than modifiedAt (from the tag)
test("modifiedAt prefers article:modified_time while publishedAt falls back to Last-Modified", () => {
  const html = `<html><head><title>T</title><meta property="article:modified_time" content="2026-02-02"></head><body><p>hi</p></body></html>`;
  const r = extractHtml(html, "https://x.com/a", "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.equal(r.modifiedAt, "2026-02-02");
  assert.equal(r.publishedAt, "2026-10-21");
  assert.ok(r.publishedAt! > r.modifiedAt!, "published is after modified — inconsistent, but this is current behaviour");
});

test("title prefers og:title over <title> and collapses its whitespace; lang is the 2-letter prefix", () => {
  const r = extractHtml(`<html lang="en-GB"><head><title>Fallback</title><meta property="og:title" content="  OG   Title  "></head><body><p>x</p></body></html>`, "https://x.com/a", null);
  assert.equal(r.title, "OG Title");
  assert.equal(r.lang, "en");
  const noOg = extractHtml(`<html><head><title>Fallback</title></head><body><p>x</p></body></html>`, "https://x.com/a", null);
  assert.equal(noOg.title, "Fallback");
  assert.equal(noOg.lang, null);
});

// the corrupted "735,,,, delegators" in the corpus lives in a meta description; keeping it out
// of `text` is what stops it reaching a chunk, an embedding and an answer
test("meta description and canonical are captured separately and never merged into the text", () => {
  const html = `<html><head><title>T</title><meta name="description" content="735,,,, delegators"><link rel="canonical" href=" https://everstake.com/about "></head><body><p>Real body.</p></body></html>`;
  const r = extractHtml(html, "https://everstake.com/about?utm_source=x", null);
  assert.equal(r.metaDescription, "735,,,, delegators");
  assert.equal(r.canonical, "https://everstake.com/about", "surrounding whitespace is trimmed");
  assert.doesNotMatch(r.text, /735/);
});

test("chrome, hidden blocks and scripts are dropped; article beats main beats body by length", () => {
  const html = `<html><head><title>T</title></head><body>
    <nav>NAVIGATION</nav><header>HEADER</header>
    <article><p>${body("Article content.")}</p><div style="display: none">HIDDEN</div><script>var x=1</script></article>
    <main><p>${body("Main content.")}</p></main>
    <footer>FOOTER</footer></body></html>`;
  const r = extractHtml(html, "https://x.com/a", null);
  assert.match(r.text, /Article content\./);
  for (const gone of ["NAVIGATION", "HEADER", "FOOTER", "HIDDEN", "var x=1", "Main content."]) assert.doesNotMatch(r.text, new RegExp(gone));

  // an <article> shorter than 300 chars is a teaser, not the page — fall through to <main>
  const teaser = `<html><head><title>T</title></head><body><article><p>too short</p></article><main><p>${body("Main content.")}</p></main></body></html>`;
  assert.match(extractHtml(teaser, "https://x.com/a", null).text, /Main content\./);

  // neither present → the whole body, with block elements turned into newlines and cells into pipes
  const bare = `<html><head><title>T</title></head><body><p>Short body.</p><table><tr><td>a</td><td>b</td></tr></table><ul><li>one</li><li>two</li></ul></body></html>`;
  assert.equal(extractHtml(bare, "https://x.com/a", null).text, "Short body.\na | b |\none\ntwo");
});

test("the Everstake legal footer is cut out while the sentence after it survives", () => {
  const html = `<html><head><title>T</title></head><body><p>Everstake, Inc. is a company and nothing here is guaranteed. Real content survives.</p></body></html>`;
  assert.equal(extractHtml(html, "https://x.com/a", null).text, "Real content survives.");
});

test("markdown extraction takes the first h1 as title, flattens links and drops images", () => {
  const r = extractMarkdown("# My Doc\n\nSee [the docs](https://x.com) and ![img](y.png).\n\n```ts\nconst a = 1;\n```\n\n## Sub\ntext", "https://x.com/f.md");
  assert.equal(r.title, "My Doc");
  assert.equal(r.text, "My Doc\n\nSee the docs and .\n\nts\nconst a = 1;\n\nSub\ntext");
  assert.deepEqual([r.publishedAt, r.canonical, r.metaDescription], [null, null, null]);
  assert.equal(r.lang, "en", "markdown sources are assumed English");
  assert.equal(extractMarkdown("no heading here", "https://x.com/f.md").title, "https://x.com/f.md", "no h1 → the URL is the title");
});

test("cleanText folds non-breaking spaces, trims each line and caps blank runs at one", () => {
  assert.equal(cleanText("a b   c \n\n\n\n d \t e  "), "a b c\n\nd e");
  assert.equal(cleanText("   "), "");
});

test("a malformed number is reported from its first bad separator, not from the start of the run", () => {
  assert.deepEqual(malformedNumbers("735,,,, and 1,6,00 and 1,600,000 and 12,34 and 1,234,,, and 99.98%"),
    ["735,,,,", "6,00", "12,34", "1,234,,,"]);
  assert.deepEqual(malformedNumbers("1,600,000 users, 130+ networks, $7B+"), []);
});
