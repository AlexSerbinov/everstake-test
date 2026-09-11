// Three sieves, cheapest first:
//   1. URL key   — canonical_key equal (redirect .one→.com, /blog/→/resources/blog/, <link canonical>)
//   2. hash      — sha1 of normalised text equal
//   3. minhash   — 5-word shingles, 64-perm MinHash for candidates, then exact Jaccard (same domain)
//                  or containment (cross-domain syndication: 56–58% of chainwire is pasted verbatim)
// Each cluster keeps ONE canonical document (highest tier, then earliest date = the origin);
// the others get duplicate_of and are excluded from chunking/answers but stay visible.

import { getConfig } from "../config.js";
import { all, run, transaction } from "../db.js";
import { normalizeText } from "../util.js";

interface Doc { id: number; canonical_key: string; content_hash: string; domain: string; tier: number; published_at: string | null; text: string }

export interface DedupReport {
  documents: number; clusters: number; aliases: number;
  by_method: Record<string, number>;
  examples: { method: string; canonical: string; alias: string; similarity: number | null }[];
}

export function dedup(): DedupReport {
  const cfg = getConfig().dedup;
  run("UPDATE documents SET duplicate_of = NULL, dedup_method = NULL, similarity = NULL WHERE status = 'ok'");
  const docs = all<Doc & { url: string }>("SELECT id, url, canonical_key, content_hash, domain, tier, published_at, text FROM documents WHERE status = 'ok' ORDER BY id");

  const parent = new Map<number, number>();
  const method = new Map<number, [string, number | null]>();
  const link = (a: Doc, b: Doc, m: string, sim: number | null) => {
    // canonical = higher tier (lower number), then earliest date, then lower id
    const [keep, drop] = pickCanonical(a, b);
    if (parent.has(drop.id)) return;
    parent.set(drop.id, keep.id);
    method.set(drop.id, [m, sim]);
  };

  // 1. URL key
  const byKey = new Map<string, Doc>();
  for (const d of docs) { const k = byKey.get(d.canonical_key); if (k) link(k, d, "url", 1); else byKey.set(d.canonical_key, d); }

  // 2. exact hash
  const byHash = new Map<string, Doc>();
  for (const d of docs) { if (parent.has(d.id)) continue; const k = byHash.get(d.content_hash); if (k) link(k, d, "hash", 1); else byHash.set(d.content_hash, d); }

  // 3. MinHash → candidates → exact similarity
  const live = docs.filter((d) => !parent.has(d.id));
  const shingles = new Map<number, Set<number>>();
  const sigs = new Map<number, Uint32Array>();
  const perms = makePerms(cfg.minhash_perms);
  for (const d of live) { const s = shingleSet(d.text, cfg.shingle_words); shingles.set(d.id, s); sigs.set(d.id, minhash(s, perms)); }
  const bands = 8, rows = cfg.minhash_perms / bands;
  const buckets = new Map<string, number[]>();
  for (const d of live) {
    const sig = sigs.get(d.id)!;
    for (let b = 0; b < bands; b++) {
      const key = b + ":" + Array.from(sig.slice(b * rows, (b + 1) * rows)).join(",");
      const arr = buckets.get(key) ?? []; arr.push(d.id); buckets.set(key, arr);
    }
  }
  const byId = new Map(live.map((d) => [d.id, d]));
  const checked = new Set<string>();
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = ids[i] < ids[j] ? `${ids[i]}-${ids[j]}` : `${ids[j]}-${ids[i]}`;
      if (checked.has(key)) continue; checked.add(key);
      const a = byId.get(ids[i])!, b = byId.get(ids[j])!;
      if (parent.has(a.id) || parent.has(b.id)) continue;
      const sa = shingles.get(a.id)!, sb = shingles.get(b.id)!;
      let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
      const jaccard = inter / (sa.size + sb.size - inter);
      const containment = inter / Math.min(sa.size, sb.size);
      if (a.domain === b.domain ? jaccard >= cfg.same_domain_jaccard : containment >= cfg.cross_domain_containment) {
        link(a, b, a.domain === b.domain ? "minhash-jaccard" : "minhash-containment", Number((a.domain === b.domain ? jaccard : containment).toFixed(3)));
      }
    }
  }

  // flatten parents (a→b→c ⇒ a→c)
  const rootOf = (id: number): number => { let cur = id; while (parent.has(cur)) cur = parent.get(cur)!; return cur; };
  const report: DedupReport = { documents: docs.length, clusters: 0, aliases: 0, by_method: {}, examples: [] };
  const urlOf = new Map(docs.map((d) => [d.id, d.url]));
  transaction(() => {
    for (const [dropId] of parent) {
      const root = rootOf(dropId);
      const [m, sim] = method.get(dropId)!;
      run("UPDATE documents SET duplicate_of = ?, dedup_method = ?, similarity = ? WHERE id = ?", root, m, sim, dropId);
      report.aliases++;
      report.by_method[m] = (report.by_method[m] ?? 0) + 1;
      if (report.examples.length < 25) report.examples.push({ method: m, canonical: urlOf.get(root)!, alias: urlOf.get(dropId)!, similarity: sim });
    }
  });
  report.clusters = new Set([...parent.keys()].map(rootOf)).size;
  return report;
}

function pickCanonical(a: Doc, b: Doc): [Doc, Doc] {
  if (a.tier !== b.tier) return a.tier < b.tier ? [a, b] : [b, a];
  const da = a.published_at ?? "9999", db = b.published_at ?? "9999";
  if (da !== db) return da < db ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

export function shingleSet(text: string, k: number): Set<number> {
  const words = normalizeText(text).split(" ");
  const out = new Set<number>();
  for (let i = 0; i + k <= words.length; i++) out.add(fnv(words.slice(i, i + k).join(" ")));
  return out;
}

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function makePerms(n: number): [number, number][] {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
  return Array.from({ length: n }, () => [rnd() | 1, rnd()] as [number, number]);
}

function minhash(s: Set<number>, perms: [number, number][]): Uint32Array {
  const sig = new Uint32Array(perms.length).fill(0xffffffff);
  for (const x of s) for (let i = 0; i < perms.length; i++) {
    const v = (Math.imul(perms[i][0], x) + perms[i][1]) >>> 0;
    if (v < sig[i]) sig[i] = v;
  }
  return sig;
}
