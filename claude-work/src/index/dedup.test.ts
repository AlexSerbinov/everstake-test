// Three sieves (URL key → content hash → MinHash/LSH) and one canonical pick per cluster.
// Run against a throw-away in-memory index: `dedup()` is deterministic (fixed permutation
// seed), so every cluster below is the real output, not an approximation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { all, run, setDbPath } from "../db.js";

setDbPath(":memory:");
const { dedup } = await import("./dedup.js");
const { normalizeText, sha1 } = await import("../util.js");

/** Disjoint vocabularies, so any shingle overlap between two documents is intentional. */
const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const BASE = words("alpha", 200);
const BASE_WORDS = BASE.split(" ");
const NEARLY = BASE_WORDS.slice(0, 190).join(" ") + " " + words("beta", 10);   // ~0.90 Jaccard with BASE
const HALF = BASE_WORDS.slice(0, 100).join(" ");
const PADDED_SMALL = HALF + " " + words("gamma", 10);                          // HALF ⊂ this, ~0.91 Jaccard
const PADDED_BIG = HALF + " " + words("gamma", 100);                           // HALF ⊂ this, ~0.49 Jaccard

let nextId = 0;
function add(url: string, domain: string, tier: number, published: string | null, text: string, key?: string) {
  const id = ++nextId;
  run(`INSERT INTO documents (id, source_id, url, canonical_key, content_hash, domain, category, tier, published_at, fetched_at, text, status)
       VALUES (?,'s',?,?,?,?,'site',?,?,'2026-09-10T00:00:00Z',?,'ok')`,
    id, url, key ?? url, sha1(normalizeText(text)), domain, tier, published, text);
  return id;
}

// --- sieve 1: three URLs that normalise to one key, arriving worst-tier-first --------------
const A = add("https://a.test/p", "a.test", 2, "2026-02-02", words("k", 60), "shared/key");
const B = add("https://everstake.com/p", "everstake.com", 1, "2026-03-03", words("m", 60), "shared/key");
const C = add("https://c.test/p", "c.test", 3, "2026-04-04", words("n", 60), "shared/key");
// --- sieve 2: identical normalised text, equal tier, different dates -----------------------
const D = add("https://d.test/h", "d.test", 2, "2026-05-05", words("eps", 200));
const E = add("https://e.test/h", "e.test", 2, "2026-01-01", words("eps", 200));
// --- sieve 3a: same domain, high Jaccard ---------------------------------------------------
const F = add("https://everstake.com/x", "everstake.com", 1, "2026-01-01", BASE);
const G = add("https://everstake.com/near", "everstake.com", 1, "2026-05-05", NEARLY);
// --- sieve 3b: cross-domain syndication, verbatim paste with a short tail ------------------
const H = add("https://f.test/src", "f.test", 2, "2026-06-06", HALF);
const I = add("https://g.test/copy", "g.test", 2, "2026-07-07", PADDED_SMALL);
// --- sieve 3c: the same paste, but buried in twice as much host text -----------------------
const J = add("https://i.test/copy", "i.test", 2, "2026-07-07", PADDED_BIG);
// --- canonical tie-breaks -------------------------------------------------------------------
const K = add("https://j.test/t", "j.test", 2, "2026-01-01", words("zeta", 60), "tie/key");
const L = add("https://k.test/t", "k.test", 2, "2026-01-01", words("eta", 60), "tie/key");
const M = add("https://l.test/u", "l.test", 2, null, words("theta", 60), "undated/key");
const N = add("https://m.test/u", "m.test", 2, "2019-01-01", words("iota", 60), "undated/key");
// --- a document that must stay alone --------------------------------------------------------
const LONE = add("https://everstake.com/unrelated", "everstake.com", 1, "2026-08-08", words("delta", 200));

const REPORT = dedup();
const rows = new Map(all<{ id: number; duplicate_of: number | null; dedup_method: string | null; similarity: number | null }>(
  "SELECT id, duplicate_of, dedup_method, similarity FROM documents").map((r) => [r.id, r]));
const canonicalOf = (id: number) => rows.get(id)!.duplicate_of;
const methodOf = (id: number) => rows.get(id)!.dedup_method;

test("equal canonical keys collapse into one cluster regardless of arrival order", () => {
  assert.deepEqual([canonicalOf(A), methodOf(A), rows.get(A)!.similarity], [B, "url", 1]);
  assert.equal(canonicalOf(B), null, "the tier-1 page is the canonical even though it arrived second");
});

// A→B was linked first, then C→A; the alias row must point at the ROOT, not at another alias,
// or the retriever's `duplicate_of IS NULL` filter would still let C through a second hop
test("a chain of aliases is flattened so every alias points straight at the cluster root", () => {
  assert.equal(canonicalOf(C), B);
  assert.equal(methodOf(C), "url");
});

test("identical normalised text is caught by hash, and the earliest date wins the tie in tier", () => {
  assert.deepEqual([canonicalOf(D), methodOf(D)], [E, "hash"]);
  assert.equal(canonicalOf(E), null, "2026-01-01 is earlier than 2026-05-05, so it is treated as the origin");
});

test("same-domain near-duplicates are clustered by exact Jaccard with the similarity recorded", () => {
  assert.deepEqual([canonicalOf(G), methodOf(G), rows.get(G)!.similarity], [F, "minhash-jaccard", 0.903]);
});

test("cross-domain syndication is clustered by containment, not Jaccard", () => {
  assert.deepEqual([canonicalOf(I), methodOf(I), rows.get(I)!.similarity], [H, "minhash-containment", 1]);
});

// suspected bug, pinned as-is: this is exactly the case the module was written for ("56–58% of
// chainwire is pasted verbatim"), and it is missed. Containment is 1.0 — well over the 0.5
// threshold — but the 8×8 MinHash banding buckets on Jaccard (~0.49 here), so the pair is never
// compared and the containment rule never gets a chance to fire.
test("a verbatim paste buried in twice as much host text is never even compared", () => {
  assert.equal(canonicalOf(J), null);
  assert.equal(methodOf(J), null);
});

test("a document with no shingle overlap is left alone", () => {
  assert.deepEqual([canonicalOf(LONE), methodOf(LONE)], [null, null]);
});

test("with equal tier and equal date the lower id is canonical; any date beats no date", () => {
  assert.equal(canonicalOf(L), K, "same tier, same day → the document crawled first is the origin");
  assert.equal(canonicalOf(K), null);
  // an undated document sorts as "9999", so even a 2019 date makes the other one canonical
  assert.equal(canonicalOf(M), N);
  assert.equal(canonicalOf(N), null);
});

test("the report counts every ok document, every alias, and one example per alias", () => {
  assert.equal(REPORT.documents, nextId);
  assert.equal(REPORT.aliases, 7);
  assert.deepEqual(REPORT.by_method, { url: 4, hash: 1, "minhash-jaccard": 1, "minhash-containment": 1 },
    "counted per alias, not per cluster");
  assert.equal(REPORT.clusters, 6, "distinct roots: B, E, F, H, K, N");
  assert.equal(REPORT.examples.length, REPORT.aliases, "under the 25-example cap every alias is shown");
  for (const ex of REPORT.examples) assert.ok(ex.canonical && ex.alias && ex.method, JSON.stringify(ex));
});

test("re-running dedup resets the previous verdicts first, so it is idempotent", () => {
  const again = dedup();
  assert.deepEqual(again.by_method, REPORT.by_method);
  assert.equal(again.aliases, REPORT.aliases);
  assert.equal(again.clusters, REPORT.clusters);
  const after = all<{ id: number; duplicate_of: number | null }>("SELECT id, duplicate_of FROM documents ORDER BY id");
  assert.deepEqual(after.map((r) => r.duplicate_of), [...rows.values()].sort((a, b) => a.id - b.id).map((r) => r.duplicate_of));
});
