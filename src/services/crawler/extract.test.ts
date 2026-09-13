import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceConfig } from "../../contracts.js";
import { extractDocument } from "./extract.js";

const source: SourceConfig = {
  id: "site",
  url: "https://public.example",
  publisher: "Example",
  authority: 1,
  kind: "website",
  reason: "Primary source",
  enabled: true,
};

test("keeps table context and distinguishes page dates from fetch time", () => {
  const html = `<html><head><title>Rates</title><meta property="article:published_time" content="2025-02-03"><script type="application/ld+json">{"dateModified":"2026-04-05"}</script></head><body><nav>Menu</nav><article><h1>Rates</h1><table><tr><th>Network</th><th>Fee</th></tr><tr><td>ETH</td><td>5%</td></tr></table><p>Terms apply.</p></article></body></html>`;
  const document = extractDocument(
    {
      url: "https://public.example/rates",
      initialUrl: "https://public.example/rates",
      redirectChain: [],
      fetchedAt: "2026-09-13T12:00:00.000Z",
      bytes: html.length,
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from(html),
    },
    source,
  );
  assert.equal(document.publishedAt, "2025-02-03T00:00:00.000Z");
  assert.equal(document.updatedAt, "2026-04-05T00:00:00.000Z");
  assert.equal(document.fetchedAt, "2026-09-13T12:00:00.000Z");
  assert.equal(document.dateEvidence, "meta:article:published_time");
  assert.deepEqual(document.metadata.dateProvenance, {
    publishedAt: "meta:article:published_time",
    updatedAt: "jsonld:dateModified",
  });
  assert.match(document.text, /Network \| Fee\nETH \| 5%/);
  assert.doesNotMatch(document.text, /Menu/);
});

test("does not treat migration headers as publication dates", () => {
  const html =
    "<article><h1>Archived article</h1><p>This article has enough original content to remain useful after a website migration without inventing a publication date.</p></article>";
  const document = extractDocument(
    {
      url: "https://public.example/archive",
      initialUrl: "https://public.example/archive",
      redirectChain: [],
      fetchedAt: "2026-09-13T12:00:00.000Z",
      bytes: html.length,
      status: 200,
      headers: {
        "content-type": "text/html",
        "last-modified": "Sun, 13 Sep 2026 10:00:00 GMT",
      },
      body: Buffer.from(html),
    },
    source,
  );
  assert.equal(document.publishedAt, null);
  assert.equal(document.updatedAt, null);
  assert.equal(document.dateEvidence, null);
  assert.equal(document.metadata.lastModified, "Sun, 13 Sep 2026 10:00:00 GMT");
});

test("extracts bounded Markdown sources without dropping tables", () => {
  const markdown =
    "---\ndate: 2025-06-01\n---\n# Validator guide\n\n| Network | Minimum |\n| --- | --- |\n| ETH | 32 ETH |\n\nSee [terms](https://public.example/terms).";
  const document = extractDocument(
    {
      url: "https://public.example/README.md",
      initialUrl: "https://public.example/README.md",
      redirectChain: [],
      fetchedAt: "2026-09-13T12:00:00.000Z",
      bytes: markdown.length,
      status: 200,
      headers: { "content-type": "text/markdown" },
      body: Buffer.from(markdown),
    },
    { ...source, kind: "github" },
  );
  assert.equal(document.title, "Validator guide");
  assert.equal(document.publishedAt, "2025-06-01T00:00:00.000Z");
  assert.match(document.text, /\| ETH \| 32 ETH \|/);
  assert.deepEqual(document.links, ["https://public.example/terms"]);
});
