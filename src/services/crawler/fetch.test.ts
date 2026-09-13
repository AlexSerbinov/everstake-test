import { test } from "node:test";
import assert from "node:assert/strict";
import { CrawlFetchError, safeFetch, type FetchTransport } from "./fetch.js";

function response(
  url: URL,
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  return { url: url.href, status, headers, body: Buffer.from(body) };
}

test("checks robots again after a redirect and refuses the disallowed path", async () => {
  const requested: string[] = [];
  const transport: FetchTransport = async (url) => {
    requested.push(url.pathname);
    if (url.pathname === "/robots.txt")
      return response(url, 200, "User-agent: *\nDisallow: /private");
    if (url.pathname === "/old")
      return response(url, 302, "", { location: "/private" });
    return response(url, 200, "secret");
  };
  await assert.rejects(
    safeFetch("https://public.example/old", {
      transport,
      resolveHost: async () => ["93.184.216.34"],
      retries: 0,
    }),
    (error: unknown) =>
      error instanceof CrawlFetchError && error.code === "robots_disallowed",
  );
  assert.deepEqual(requested, ["/robots.txt", "/old"]);
});

test("blocks private destinations before the transport runs", async () => {
  let called = false;
  await assert.rejects(
    safeFetch("http://internal.example/admin", {
      resolveHost: async () => ["127.0.0.1"],
      transport: async (url) => {
        called = true;
        return response(url, 200, "no");
      },
    }),
    (error: unknown) =>
      error instanceof CrawlFetchError && error.code === "private_destination",
  );
  assert.equal(called, false);
});

test("refuses cross-origin redirects even when both hosts are public", async () => {
  const transport: FetchTransport = async (url) =>
    url.pathname === "/robots.txt"
      ? response(url, 404, "")
      : response(url, 302, "", { location: "https://other.example/page" });
  await assert.rejects(
    safeFetch("https://public.example/page", {
      transport,
      resolveHost: async () => ["93.184.216.34"],
      retries: 0,
    }),
    (error: unknown) =>
      error instanceof CrawlFetchError &&
      error.code === "cross_origin_redirect",
  );
});

test("retries a temporary HTTP failure within the configured bound", async () => {
  let pageAttempts = 0;
  const transport: FetchTransport = async (url) => {
    if (url.pathname === "/robots.txt") return response(url, 404, "");
    pageAttempts += 1;
    return pageAttempts === 1
      ? response(url, 503, "busy")
      : response(url, 200, "available");
  };
  const result = await safeFetch("https://public.example/page", {
    transport,
    resolveHost: async () => ["93.184.216.34"],
    retries: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.body.toString(), "available");
  assert.equal(pageAttempts, 2);
});
