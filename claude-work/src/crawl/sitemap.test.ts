// Sitemap parsing decides which pages exist at all, so a silently dropped <url> is a silently
// missing document. Served from a stubbed fetch — no network, crawl delay overridden to 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfig, setConfigOverrides } from "../config.js";
import { readSitemap } from "./sitemap.js";

setConfigOverrides({ crawl: { ...getConfig().crawl, delay_ms: 0, retries: 0 } });

const HOST = "https://sm.test";
let served: Record<string, string | number> = {};

const real = globalThis.fetch;
globalThis.fetch = (async (input: any) => {
  const url = String(input);
  if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
  const hit = served[url];
  if (hit === undefined) return new Response("", { status: 404 });
  if (typeof hit === "number") return new Response("", { status: hit });
  return new Response(hit, { status: 200, headers: { "content-type": "application/xml" } });
}) as typeof fetch;
process.on("exit", () => { globalThis.fetch = real; });

const urlset = (...entries: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}</urlset>`;
const index = (...locs: string[]) => `<?xml version="1.0"?><sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc><lastmod>2026-01-01</lastmod></sitemap>`).join("")}</sitemapindex>`;

test("a urlset yields one entry per <url>, tagged with the sitemap it came from", async () => {
  served = {
    [`${HOST}/sitemap.xml`]: urlset(
      `<url><loc>${HOST}/a</loc><lastmod>2026-05-05</lastmod></url>`,
      `<url><loc>  ${HOST}/b  </loc></url>`),
  };
  assert.deepEqual(await readSitemap(`${HOST}/sitemap.xml`), [
    { url: `${HOST}/a`, lastmod: "2026-05-05", sitemap: `${HOST}/sitemap.xml` },
    { url: `${HOST}/b`, lastmod: null, sitemap: `${HOST}/sitemap.xml` },
  ]);
});

test("XML entities in <loc> are decoded so the crawler asks for the real URL", async () => {
  served = { [`${HOST}/s.xml`]: urlset(`<url><loc>${HOST}/p?a=1&amp;b=2&#39;x&quot;y</loc></url>`) };
  const [e] = await readSitemap(`${HOST}/s.xml`);
  assert.equal(e.url, `${HOST}/p?a=1&b=2'x"y`);
});

test("a <url> without a <loc> is dropped rather than emitted as a blank entry", async () => {
  served = { [`${HOST}/s2.xml`]: urlset(`<url><lastmod>2026-01-01</lastmod></url>`, `<url><loc>${HOST}/ok</loc></url>`) };
  const out = await readSitemap(`${HOST}/s2.xml`);
  assert.deepEqual(out.map((e) => e.url), [`${HOST}/ok`]);
});

test("a sitemap index is followed and each child's entries keep their own sitemap URL", async () => {
  served = {
    [`${HOST}/index.xml`]: index(`${HOST}/one.xml`, `${HOST}/two.xml`),
    [`${HOST}/one.xml`]: urlset(`<url><loc>${HOST}/1</loc></url>`),
    [`${HOST}/two.xml`]: urlset(`<url><loc>${HOST}/2</loc></url>`),
  };
  const out = await readSitemap(`${HOST}/index.xml`);
  assert.deepEqual(out, [
    { url: `${HOST}/1`, lastmod: null, sitemap: `${HOST}/one.xml` },
    { url: `${HOST}/2`, lastmod: null, sitemap: `${HOST}/two.xml` },
  ]);
  // the index's own <lastmod> belongs to the child sitemap, not to any page, and is discarded
  assert.equal(out.every((e) => e.lastmod === null), true);
});

// the depth cap is what stops a self-referencing index from looping forever
test("index nesting is followed three levels deep and the fourth is refused", async () => {
  served = {
    [`${HOST}/l0.xml`]: index(`${HOST}/l1.xml`),
    [`${HOST}/l1.xml`]: index(`${HOST}/l2.xml`),
    [`${HOST}/l2.xml`]: urlset(`<url><loc>${HOST}/deep-ok</loc></url>`),
  };
  assert.deepEqual((await readSitemap(`${HOST}/l0.xml`)).map((e) => e.url), [`${HOST}/deep-ok`]);

  served = {
    [`${HOST}/m0.xml`]: index(`${HOST}/m1.xml`),
    [`${HOST}/m1.xml`]: index(`${HOST}/m2.xml`),
    [`${HOST}/m2.xml`]: index(`${HOST}/m3.xml`),
    [`${HOST}/m3.xml`]: urlset(`<url><loc>${HOST}/too-deep</loc></url>`),
  };
  assert.deepEqual(await readSitemap(`${HOST}/m0.xml`), [], "the fourth level is never fetched");
});

test("an unreachable or non-200 sitemap yields no entries instead of throwing", async () => {
  served = { [`${HOST}/gone.xml`]: 403 };
  assert.deepEqual(await readSitemap(`${HOST}/gone.xml`), []);
  served = {};
  assert.deepEqual(await readSitemap(`${HOST}/missing.xml`), []);
});

test("a child sitemap that fails does not lose the entries of its healthy siblings", async () => {
  served = {
    [`${HOST}/mix.xml`]: index(`${HOST}/broken.xml`, `${HOST}/good.xml`),
    [`${HOST}/broken.xml`]: 404,
    [`${HOST}/good.xml`]: urlset(`<url><loc>${HOST}/survivor</loc></url>`),
  };
  assert.deepEqual((await readSitemap(`${HOST}/mix.xml`)).map((e) => e.url), [`${HOST}/survivor`]);
});
