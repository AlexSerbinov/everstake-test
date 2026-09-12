// Pipeline: crawl → **canon** → dedup → index → facts → retrieve → answer → eval.
//
// URL canonicalisation — sieve 1 of deduplication and the cheapest one: a string comparison,
// no text read at all. `canonicalKey` maps every spelling of one page onto a single key, so
// dedup can collapse a cluster before it has hashed or shingled anything. The crawler calls it
// on three URLs per document — the seed URL, the final URL after redirects, and any
// <link rel=canonical> — which is how a redirect chain and a publisher-declared canonical end
// up in the same cluster as the page itself.
//
// If this is wrong in the loose direction, two different pages merge and one of them silently
// disappears from every answer (its chunks are never indexed). If it is wrong in the strict
// direction, the same page is counted several times and syndication starts to look like
// independent corroboration. The strict direction is the safer failure and the one we live
// with today — see the KNOWN LIMITATION below.
//
// Rules verified against the live site (see docs/crawl-survey): *.everstake.one → .com,
// /blog/<slug> → /resources/blog/<slug>, tracking params dropped, fragments dropped.

// Query parameters that identify the *referrer*, not the page: two URLs differing only in these
// are the same document. `utm_` and `mc_` (Mailchimp) are family prefixes; the rest are anchored
// with `$` so `sourceid` and `referrer` — which can be real routing params — are kept.
const TRACKING = /^(utm_|ref$|fbclid$|gclid$|source$|mc_)/i;

/**
 * Reduce a URL to the identity of the page behind it. Equal keys mean "one document" to
 * `dedup()`, so every rule here is a claim that the two spellings really do serve the same
 * content — each one below was confirmed against the live site rather than assumed.
 *
 * Not a URL at all (a bare title, an empty href) falls back to the trimmed, lower-cased input
 * instead of throwing: the crawler feeds this raw <link rel=canonical> attributes, and one
 * malformed tag must not abort a crawl.
 */
export function canonicalKey(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url.trim().toLowerCase(); }

  // http and https serve the same content everywhere in this corpus, so the scheme is not part
  // of the identity; neither is a `www.` prefix.
  parsed.protocol = "https:";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.hostname = rewriteLegacyHost(parsed.hostname);

  // The blog moved under /resources/ during the .one → .com migration. Guarded on the apex host:
  // blog.everstake.com/blog/x was never moved, so rewriting it there would invent a dead key.
  if (parsed.hostname === "everstake.com") {
    parsed.pathname = parsed.pathname.replace(/^\/blog\//, "/resources/blog/");
  }

  parsed.hash = "";                       // a fragment scrolls the page, it does not change it
  for (const param of [...parsed.searchParams.keys()]) {
    if (TRACKING.test(param)) parsed.searchParams.delete(param);
  }

  // KNOWN LIMITATION: only TRAILING slashes collapse, so `//about` and `/about` — the same page
  // for the server — produce two different keys and this cheapest sieve misses the pair. Left
  // as-is deliberately; `canon.test.ts` pins the current output.
  let path = parsed.pathname.replace(/\/+$/, "") || "/";
  path = path.replace(/\.md$/, "");       // docs pages served as .md are the same page

  // Surviving params stay in the key: ?page=2 on an index page is a different page of results.
  const query = parsed.searchParams.toString();
  return `${parsed.hostname}${path}${query ? "?" + query : ""}`;
}

/** everstake.one was retired in favour of everstake.com, apex and subdomains alike. */
function rewriteLegacyHost(hostname: string): string {
  if (hostname === "everstake.one") return "everstake.com";
  // eth-docs is the exception: it is still served from .one and its .com twin is a different
  // (empty) host, so rewriting it would merge a live page with a dead one.
  if (hostname.endsWith(".everstake.one") && hostname !== "eth-docs.everstake.one") {
    return hostname.replace(/\.everstake\.one$/, ".everstake.com");
  }
  return hostname;
}

/**
 * Soft-404: the server answered 200 but sent us to the site root instead of the page we asked
 * for (atomicwallet does this for retired blog posts). Without this check the crawler stores the
 * home page under a dozen different seed URLs and dedup then reports a dozen false aliases.
 *
 * A cross-site canonical pointing at someone else's home page is NOT a soft-404 — that is what a
 * syndicated post legitimately looks like — hence the same-host condition on the canonical arm.
 */
export function isSoftRoot(seedUrl: string, finalUrl: string, canonical: string | null): boolean {
  const seedPath = new URL(seedUrl).pathname.replace(/\/+$/, "");
  if (!seedPath) return false;            // we asked for the root, so landing on it proves nothing

  const pointsAtRoot = (candidateUrl: string | null) => {
    if (!candidateUrl) return false;
    try { return new URL(candidateUrl).pathname.replace(/\/+$/, "") === ""; } catch { return false; }
  };

  return pointsAtRoot(finalUrl)
    || (pointsAtRoot(canonical) && new URL(canonical!).hostname === new URL(finalUrl).hostname);
}
