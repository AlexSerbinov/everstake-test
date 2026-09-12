// Pipeline: crawl → **dedup** → index/build → facts → retrieve → answer → eval.
//
// The corpus contains the same press release nine times, the blog under two domains, and product
// shells that render to identical text. Without this step every copy is chunked, so a retriever
// that returns "five independent sources" is really returning one source five times, and the
// answer model reads that as corroboration. Dedup keeps exactly ONE canonical document per
// cluster; the others get `duplicate_of` set and are excluded from chunking and answering, but
// stay in the database so the UI can show what was folded into what.
//
// Three sieves run in order, cheapest first, and each one shrinks the input to the next:
//   1. URL key   — string equality on `canonical_key` (redirect .one→.com, /blog/→/resources/blog/,
//                  <link rel=canonical>). No document text is read at all.
//   2. hash      — sha1 of the normalised text. One pass, exact matches only.
//   3. MinHash   — 5-word shingles + banded LSH to find near-duplicate CANDIDATES, then an exact
//                  Jaccard (same domain) or containment (cross-domain syndication) check.
// The ordering is not cosmetic: sieve 3 is the only one that costs real work (a signature per
// document plus a pairwise comparison per bucketed pair), so sieves 1 and 2 exist to keep the
// number of documents that reach it small.
//
// If dedup is too aggressive a real second source vanishes from the index; if it is too timid,
// syndication is counted as agreement. `dedup.test.ts` pins every cluster this produces.

import { getConfig } from "../config.js";
import { all, run, transaction } from "../db.js";
import { normalizeText } from "../util.js";

// LSH banding: the 64-value signature is cut into 8 bands of 8 rows, and two documents become
// candidates if any one band matches exactly. Probability of being bucketed is
// 1 - (1 - jaccard^rows)^bands, which is ~0.996 at Jaccard 0.9 and ~0.03 at Jaccard 0.5 — i.e. a
// deliberately steep filter that keeps near-identical pairs and drops the rest before the O(n²)
// comparison. 8×8 is hand-tuned to that curve; no measurement backs the exact split.
const BANDS = 8;

// Only the first 25 alias pairs are carried in the report — it is a human-readable sample for the
// UI and the CLI, not the data (the full mapping lives in `documents.duplicate_of`).
const MAX_REPORT_EXAMPLES = 25;

interface Doc {
  id: number;
  canonical_key: string;
  content_hash: string;
  domain: string;
  tier: number;
  published_at: string | null;
  text: string;
}

export interface DedupReport {
  documents: number;
  clusters: number;
  aliases: number;
  by_method: Record<string, number>;
  examples: { method: string; canonical: string; alias: string; similarity: number | null }[];
}

/** Records "document X is a copy of document Y, found by sieve M with similarity S". */
type LinkDuplicate = (one: Doc, other: Doc, method: string, similarity: number | null) => void;

/**
 * Re-derive the whole duplicate map from scratch and write it to `documents`. Idempotent by
 * design (it clears the previous verdicts first) because it is re-run after every crawl, and a
 * stale `duplicate_of` would keep a page hidden after the duplicate that caused it was removed.
 */
export function dedup(): DedupReport {
  const dedupConfig = getConfig().dedup;
  run("UPDATE documents SET duplicate_of = NULL, dedup_method = NULL, similarity = NULL WHERE status = 'ok'");
  const docs = all<Doc & { url: string }>(
    `SELECT id, url, canonical_key, content_hash, domain, tier, published_at, text
     FROM documents WHERE status = 'ok' ORDER BY id`);

  // alias id → the document it was folded into, and which sieve decided that.
  const parentOf = new Map<number, number>();
  const methodOf = new Map<number, [string, number | null]>();
  const link: LinkDuplicate = (one, other, method, similarity) => {
    const [canonical, alias] = pickCanonical(one, other);
    // Already claimed by an earlier (cheaper, more certain) sieve — first verdict wins.
    if (parentOf.has(alias.id)) return;
    parentOf.set(alias.id, canonical.id);
    methodOf.set(alias.id, [method, similarity]);
  };

  linkByCanonicalKey(docs, link);
  linkByContentHash(docs, parentOf, link);
  linkByNearDuplicateText(docs.filter((doc) => !parentOf.has(doc.id)), parentOf, link, dedupConfig);

  return persistAndReport(docs, parentOf, methodOf);
}

/** Sieve 1: identical `canonical_key`. Arrival order is irrelevant — `pickCanonical` decides. */
function linkByCanonicalKey(docs: Doc[], link: LinkDuplicate): void {
  const firstWithKey = new Map<string, Doc>();
  for (const doc of docs) {
    const seen = firstWithKey.get(doc.canonical_key);
    if (seen) link(seen, doc, "url", 1);
    else firstWithKey.set(doc.canonical_key, doc);
  }
}

/**
 * Sieve 2: identical sha1 of the normalised text — different URLs, byte-identical content after
 * lower-casing and whitespace collapsing. Catches client-rendered shells (several /staking/
 * protocol pages that ship the same skeleton) and mirrors that kept the copy exact.
 */
function linkByContentHash(docs: Doc[], parentOf: Map<number, number>, link: LinkDuplicate): void {
  const firstWithHash = new Map<string, Doc>();
  for (const doc of docs) {
    if (parentOf.has(doc.id)) continue;   // sieve 1 already resolved this one
    const seen = firstWithHash.get(doc.content_hash);
    if (seen) link(seen, doc, "hash", 1);
    else firstWithHash.set(doc.content_hash, doc);
  }
}

/**
 * Sieve 3: near-duplicates. Comparing every surviving pair exactly would be O(n²) over full
 * shingle sets, so MinHash+LSH proposes candidates cheaply and only those pairs are measured
 * exactly. Everything the LSH does not bucket is never compared — see the KNOWN LIMITATION.
 */
function linkByNearDuplicateText(
  liveDocs: Doc[],
  parentOf: Map<number, number>,
  link: LinkDuplicate,
  dedupConfig: { shingle_words: number; minhash_perms: number; same_domain_jaccard: number; cross_domain_containment: number },
): void {
  const shingles = new Map<number, Set<number>>();
  const signatures = new Map<number, Uint32Array>();
  const perms = makePerms(dedupConfig.minhash_perms);
  for (const doc of liveDocs) {
    const shingleFingerprints = shingleSet(doc.text, dedupConfig.shingle_words);
    shingles.set(doc.id, shingleFingerprints);
    signatures.set(doc.id, minhash(shingleFingerprints, perms));
  }

  const docById = new Map(liveDocs.map((doc) => [doc.id, doc]));
  for (const [firstId, secondId] of bandedCandidatePairs(liveDocs, signatures, dedupConfig.minhash_perms)) {
    // Re-checked here rather than up front: an earlier pair in this same loop may have just made
    // one of these two an alias, and an alias must not become the parent of a third document.
    if (parentOf.has(firstId) || parentOf.has(secondId)) continue;
    const first = docById.get(firstId)!;
    const second = docById.get(secondId)!;

    const firstShingles = shingles.get(firstId)!;
    const secondShingles = shingles.get(secondId)!;
    let shared = 0;
    for (const fingerprint of firstShingles) if (secondShingles.has(fingerprint)) shared++;

    const sameDomain = first.domain === second.domain;
    // Jaccard = shared / union: "how much of everything these two say is said by both".
    // Containment = shared / the smaller set: "how much of the shorter one is inside the longer".
    const jaccard = shared / (firstShingles.size + secondShingles.size - shared);
    const containment = shared / Math.min(firstShingles.size, secondShingles.size);

    // Two documents on the SAME domain are two of our pages; a genuine rewrite shares little, and
    // the shared page chrome alone already scores ~0.22, so symmetric Jaccard ≥ 0.5 is the honest
    // test. ACROSS domains the pattern is syndication: a press release pasted whole into a longer
    // article shares 100% of itself but only a fraction of the host page's total text, which
    // Jaccard scores as "different". Containment asks the question that actually matters there —
    // "is one of these entirely contained in the other" — and that is what makes the nine copies
    // of the chainwire release collapse into one source.
    const score = sameDomain ? jaccard : containment;
    const threshold = sameDomain ? dedupConfig.same_domain_jaccard : dedupConfig.cross_domain_containment;

    // KNOWN LIMITATION: the cross-domain arm is close to unreachable. Banding buckets pairs by
    // JACCARD, but this rule tests CONTAINMENT. A verbatim paste making up ~half of a longer host
    // page sits at Jaccard ≈ 0.49 → ~3% chance of ever landing in a shared bucket, so the
    // containment check almost never runs — precisely the "56–58% of chainwire pasted verbatim"
    // band this module was written for. Pinned as-is by dedup.test.ts; a fix means bucketing on
    // something containment-aware (e.g. banding the shorter document's signature), not retuning
    // the threshold.
    if (score >= threshold) {
      const method = sameDomain ? "minhash-jaccard" : "minhash-containment";
      link(first, second, method, Number(score.toFixed(3)));
    }
  }
}

/**
 * LSH bucketing: two documents are candidates if any one of the 8 signature bands is identical.
 * Returns each unordered pair once, in the order the buckets produced it (the caller links as it
 * goes, so order is part of the pinned behaviour).
 */
function bandedCandidatePairs(
  liveDocs: Doc[],
  signatures: Map<number, Uint32Array>,
  permCount: number,
): [number, number][] {
  const rowsPerBand = permCount / BANDS;
  const buckets = new Map<string, number[]>();
  for (const doc of liveDocs) {
    const signature = signatures.get(doc.id)!;
    for (let band = 0; band < BANDS; band++) {
      // The band index prefixes the key so band 0 of one document cannot collide with band 3 of
      // another that happens to hold the same 8 values.
      const bandKey = band + ":" + Array.from(signature.slice(band * rowsPerBand, (band + 1) * rowsPerBand)).join(",");
      const bucket = buckets.get(bandKey) ?? [];
      bucket.push(doc.id);
      buckets.set(bandKey, bucket);
    }
  }

  const pairs: [number, number][] = [];
  const seenPairs = new Set<string>();
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // Normalised key, because the same pair usually matches in several bands at once.
        const pairKey = ids[i] < ids[j] ? `${ids[i]}-${ids[j]}` : `${ids[j]}-${ids[i]}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        pairs.push([ids[i], ids[j]]);
      }
    }
  }
  return pairs;
}

/**
 * Write one `duplicate_of` row per alias and summarise. Aliases are flattened to the cluster ROOT
 * first: sieve 1 can produce a chain A→B→C, and the retriever filters on `duplicate_of IS NULL`
 * in a single hop, so an alias pointing at another alias would leak back into the index.
 */
function persistAndReport(
  docs: (Doc & { url: string })[],
  parentOf: Map<number, number>,
  methodOf: Map<number, [string, number | null]>,
): DedupReport {
  const rootOf = (id: number): number => {
    let current = id;
    while (parentOf.has(current)) current = parentOf.get(current)!;
    return current;
  };

  const report: DedupReport = { documents: docs.length, clusters: 0, aliases: 0, by_method: {}, examples: [] };
  const urlOf = new Map(docs.map((doc) => [doc.id, doc.url]));

  // One transaction for all of them: a half-applied duplicate map would hide documents whose
  // canonical was never written.
  transaction(() => {
    for (const [aliasId] of parentOf) {
      const root = rootOf(aliasId);
      const [method, similarity] = methodOf.get(aliasId)!;
      run("UPDATE documents SET duplicate_of = ?, dedup_method = ?, similarity = ? WHERE id = ?", root, method, similarity, aliasId);
      report.aliases++;
      report.by_method[method] = (report.by_method[method] ?? 0) + 1;
      if (report.examples.length < MAX_REPORT_EXAMPLES) {
        report.examples.push({ method, canonical: urlOf.get(root)!, alias: urlOf.get(aliasId)!, similarity });
      }
    }
  });

  report.clusters = new Set([...parentOf.keys()].map(rootOf)).size;
  return report;
}

/**
 * Which of two copies is the one we keep: highest tier (1 = everstake.com, 2 = press, 3 = other),
 * then the EARLIEST publication date, then the lowest id.
 *
 * Earliest, not latest, because in a syndication cluster the first-published copy is the origin
 * and the later ones are the reprints — keeping the origin means the citation points at who
 * actually said it. An undated document sorts as "9999", i.e. behind every dated one: a date we
 * could not extract is weaker evidence of origin than any date we could.
 */
function pickCanonical(one: Doc, other: Doc): [Doc, Doc] {
  if (one.tier !== other.tier) return one.tier < other.tier ? [one, other] : [other, one];
  const oneDate = one.published_at ?? "9999";
  const otherDate = other.published_at ?? "9999";
  if (oneDate !== otherDate) return oneDate < otherDate ? [one, other] : [other, one];
  return one.id < other.id ? [one, other] : [other, one];
}

/**
 * A document as a set of overlapping k-word windows ("shingles"): "a b c d e f" with k=5 gives
 * {"a b c d e", "b c d e f"}. Word-level rather than character-level so the unit is phrasing,
 * and overlapping so moving a paragraph does not change the set — which is what makes two
 * reprints of one press release look identical while two articles about the same event do not.
 * Stored as 32-bit hashes, not strings: a 200-word page is 196 shingles and we hold every
 * surviving document's set in memory at once.
 */
export function shingleSet(text: string, wordsPerShingle: number): Set<number> {
  const words = normalizeText(text).split(" ");
  const fingerprints = new Set<number>();
  for (let i = 0; i + wordsPerShingle <= words.length; i++) {
    fingerprints.add(fnv1a(words.slice(i, i + wordsPerShingle).join(" ")));
  }
  return fingerprints;
}

/** FNV-1a 32-bit. Not cryptographic — it only has to spread shingles evenly and be fast. */
function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The 64 hash permutations `(multiplier, offset)` that define the MinHash signature. Generated
 * from a FIXED seed so two runs over the same corpus produce byte-identical clusters — dedup is
 * re-run on every crawl and its output is asserted in tests, so it must not be random.
 * The multiplier is forced odd (`| 1`) to keep the map a bijection over 32-bit integers.
 */
function makePerms(count: number): [number, number][] {
  let seed = 12345;
  const nextRandom = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  return Array.from({ length: count }, () => [nextRandom() | 1, nextRandom()] as [number, number]);
}

/**
 * MinHash signature: for each permutation, the smallest permuted shingle hash in the set. The
 * useful property is that the chance two documents share a given signature slot equals their
 * Jaccard similarity — so 64 fixed-size slots stand in for shingle sets of any length, and the
 * banding in `bandedCandidatePairs` can compare them by equality instead of intersecting sets.
 */
function minhash(fingerprints: Set<number>, perms: [number, number][]): Uint32Array {
  const signature = new Uint32Array(perms.length).fill(0xffffffff);
  for (const fingerprint of fingerprints) {
    for (let i = 0; i < perms.length; i++) {
      const permuted = (Math.imul(perms[i][0], fingerprint) + perms[i][1]) >>> 0;
      if (permuted < signature[i]) signature[i] = permuted;
    }
  }
  return signature;
}
