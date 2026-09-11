// URL canonicalisation — the cheapest dedup sieve. Applied to seed URL, final URL after
// redirects, and <link rel=canonical>. Two documents with the same key are one document.
//
// Rules verified against the live site (see docs/crawl-survey): *.everstake.one → .com,
// /blog/<slug> → /resources/blog/<slug>, tracking params dropped, fragments dropped.

const TRACKING = /^(utm_|ref$|fbclid$|gclid$|source$|mc_)/i;

export function canonicalKey(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url.trim().toLowerCase(); }
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if (u.hostname === "everstake.one") u.hostname = "everstake.com";
  else if (u.hostname.endsWith(".everstake.one") && u.hostname !== "eth-docs.everstake.one") u.hostname = u.hostname.replace(/\.everstake\.one$/, ".everstake.com");
  if (u.hostname === "everstake.com") u.pathname = u.pathname.replace(/^\/blog\//, "/resources/blog/");
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  // keep ?page=N for index pages, drop everything else that is empty
  let path = u.pathname.replace(/\/+$/, "") || "/";
  path = path.replace(/\.md$/, ""); // docs pages served as .md are the same page
  const q = u.searchParams.toString();
  return `${u.hostname}${path}${q ? "?" + q : ""}`;
}

/** Soft-404: the server "found" the page but sent us to the site root (atomicwallet does this). */
export function isSoftRoot(seedUrl: string, finalUrl: string, canonical: string | null): boolean {
  const seedPath = new URL(seedUrl).pathname.replace(/\/+$/, "");
  if (!seedPath) return false;
  const isRoot = (u: string | null) => { if (!u) return false; try { return new URL(u).pathname.replace(/\/+$/, "") === ""; } catch { return false; } };
  return isRoot(finalUrl) || (isRoot(canonical) && new URL(canonical!).hostname === new URL(finalUrl).hostname);
}
