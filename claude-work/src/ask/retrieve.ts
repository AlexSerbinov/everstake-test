// Hybrid retrieval with explainable ranking.
//   BM25 (FTS5) top-N  ∪  cosine top-N  →  Reciprocal Rank Fusion
//   score = rrf × recency(published_at) × authority(tier, ai_directed)
// Every number is kept on the candidate so the UI can show WHY a chunk won.

import { getConfig } from "../config.js";
import { all, blobToFloats } from "../db.js";
import { cosine, embed, embeddingsEnabled } from "../embeddings.js";

/** Categories whose undated pages are "live" (they describe the present as of the fetch). */
const LIVE_CATEGORIES = new Set(["site", "docs", "code"]);

export interface Candidate {
  chunk_id: number; doc_id: number; url: string; title: string; published_at: string | null; tier: number; domain: string; ai_directed: number;
  category: string; fetched_at: string;
  date_kind: "published" | "live" | "undated"; effective_date: string | null;
  text: string;
  bm25_rank: number | null; vec_rank: number | null; cosine: number | null;
  rrf: number; recency: number; authority: number; score: number;
  selected_by?: "top" | "date-diverse";
}

export interface FactRow { id: number; key: string; value: string; as_of: string | null; quote: string; confidence: number; flags: string | null; doc_id: number; url: string; title: string; tier: number; published_at: string | null; ai_directed: number }

export interface Retrieval { candidates: Candidate[]; selected: Candidate[]; facts: FactRow[]; vector_used: boolean; fts_query: string }

const STOP = new Set("a an the of in on at to for and or is are was were be been do does did how what which who whom when where why has have had it its this that these those with from by as about over after before than into up out many much more most any some such".split(" "));

export function ftsQuery(q: string): string {
  const terms = q.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));
  const uniq = [...new Set(terms)];
  return uniq.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

let vecCache: { count: number; rows: { id: number; v: Float32Array }[] } | null = null;
function chunkVectors() {
  const count = (all<{ n: number }>("SELECT COUNT(*) n FROM chunks WHERE embedding IS NOT NULL")[0]?.n) ?? 0;
  if (!vecCache || vecCache.count !== count) {
    vecCache = { count, rows: all<{ id: number; embedding: Uint8Array }>("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL").map((r) => ({ id: r.id, v: blobToFloats(r.embedding) })) };
  }
  return vecCache.rows;
}

function filterSql(alias = "d") {
  const f = getConfig().filters;
  const parts = [`${alias}.status='ok'`, `${alias}.duplicate_of IS NULL`];
  const params: any[] = [];
  if (f.include_tiers?.length) { parts.push(`${alias}.tier IN (${f.include_tiers.map(() => "?").join(",")})`); params.push(...f.include_tiers); }
  for (const dom of f.excluded_domains ?? []) { parts.push(`${alias}.domain NOT LIKE ?`); params.push(`%${dom}`); }
  if (f.min_published_year) { parts.push(`(${alias}.published_at IS NULL OR ${alias}.published_at >= ?)`); params.push(`${f.min_published_year}-01-01`); }
  return { where: parts.join(" AND "), params };
}

export function recencyMultiplier(published: string | null, now = Date.now()): number {
  const r = getConfig().ranking;
  if (!published) return r.undated_recency;
  const days = Math.max(0, (now - new Date(published).getTime()) / 86_400_000);
  return Math.max(r.recency_floor, Math.pow(0.5, days / r.recency_half_life_days));
}

export function authorityMultiplier(tier: number, aiDirected: number): number {
  const r = getConfig().ranking;
  return (r.tier_weights[String(tier)] ?? 0.5) * (aiDirected ? r.ai_directed_multiplier : 1);
}

export async function retrieve(question: string): Promise<Retrieval> {
  const cfg = getConfig();
  const { where, params } = filterSql();
  const q = ftsQuery(question);

  // --- BM25 --------------------------------------------------------------------
  const bm25 = q ? all<{ id: number; score: number }>(
    `SELECT c.id, bm25(chunks_fts) score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id
     WHERE chunks_fts MATCH ? AND ${where} ORDER BY score LIMIT ?`, q, ...params, cfg.retrieval.bm25_top) : [];

  // --- vector ------------------------------------------------------------------
  let vec: { id: number; cos: number }[] = [];
  const vectorUsed = embeddingsEnabled();
  if (vectorUsed) {
    const [qv] = await embed([question], "query");
    const allowed = new Set(all<{ id: number }>(`SELECT c.id FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE ${where}`, ...params).map((r) => r.id));
    vec = chunkVectors().filter((r) => allowed.has(r.id)).map((r) => ({ id: r.id, cos: cosine(qv, r.v) })).sort((a, b) => b.cos - a.cos).slice(0, cfg.retrieval.vector_top);
  }

  // --- fuse --------------------------------------------------------------------
  const k = cfg.retrieval.rrf_k;
  const byId = new Map<number, Partial<Candidate>>();
  bm25.forEach((r, i) => { byId.set(r.id, { chunk_id: r.id, bm25_rank: i + 1, rrf: 1 / (k + i + 1) }); });
  vec.forEach((r, i) => { const c = byId.get(r.id) ?? { chunk_id: r.id, rrf: 0 }; c.vec_rank = i + 1; c.cosine = Number(r.cos.toFixed(4)); c.rrf = (c.rrf ?? 0) + 1 / (k + i + 1); byId.set(r.id, c); });
  if (byId.size === 0) return { candidates: [], selected: [], facts: factsFor(question), vector_used: vectorUsed, fts_query: q };

  const ids = [...byId.keys()];
  const rows = all<any>(
    `SELECT c.id chunk_id, c.doc_id, c.text, d.url, d.title, d.published_at, d.fetched_at, d.category, d.tier, d.domain, d.ai_directed
     FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${ids.map(() => "?").join(",")})`, ...ids);
  const candidates: Candidate[] = rows.map((r) => {
    const p = byId.get(r.chunk_id)!;
    // Evergreen site/docs pages without a publication date describe the state at fetch time
    // ("live page"); a dated announcement older than that must not override them.
    const live = !r.published_at && LIVE_CATEGORIES.has(r.category);
    r.date_kind = r.published_at ? "published" : live ? "live" : "undated";
    r.effective_date = r.published_at ?? (live ? r.fetched_at.slice(0, 10) : null);
    const recency = recencyMultiplier(r.effective_date);
    const authority = authorityMultiplier(r.tier, r.ai_directed);
    const rrf = p.rrf ?? 0;
    return { ...r, bm25_rank: p.bm25_rank ?? null, vec_rank: p.vec_rank ?? null, cosine: p.cosine ?? null, rrf: Number(rrf.toFixed(5)), recency: Number(recency.toFixed(3)), authority, score: Number((rrf * recency * authority).toFixed(5)) };
  }).sort((a, b) => b.score - a.score);

  // --- select: top-N + best chunk per additional year (so synthesis sees the trajectory) --
  const selected: Candidate[] = candidates.slice(0, cfg.retrieval.final_top).map((c) => ({ ...c, selected_by: "top" as const }));
  const usedDocs = new Set(selected.map((c) => c.doc_id));
  const years = new Set(selected.map((c) => c.effective_date?.slice(0, 4)).filter(Boolean));
  for (const c of candidates.slice(cfg.retrieval.final_top)) {
    if (selected.length >= cfg.retrieval.final_top + cfg.retrieval.date_diverse_extra) break;
    const y = c.effective_date?.slice(0, 4);
    if (!y || years.has(y) || usedDocs.has(c.doc_id)) continue;
    years.add(y); usedDocs.add(c.doc_id);
    selected.push({ ...c, selected_by: "date-diverse" });
  }
  return { candidates, selected, facts: factsFor(question), vector_used: vectorUsed, fts_query: q };
}

/** Fact ledger rows that match the question (FTS over key+value+quote), newest first. */
export function factsFor(question: string, limit = 14): FactRow[] {
  const { where, params } = filterSql();
  const hinted = keyHints(question).split(" ").filter(Boolean);
  const SELECT = `SELECT f.id, f.key, f.value, f.as_of, f.quote, f.confidence, f.flags, d.id doc_id, d.url, d.title, d.tier, d.published_at, d.ai_directed`;
  let rows: FactRow[];
  if (hinted.length) {
    // the question names a ledger key → take that key's whole history, not an FTS sample of it
    rows = all<FactRow>(`${SELECT} FROM facts f JOIN documents d ON d.id = f.doc_id
       WHERE f.key IN (${hinted.map(() => "?").join(",")}) AND ${where} AND (f.flags IS NULL OR f.flags NOT LIKE '%malformed%')`, ...hinted, ...params);
  } else {
    const q = ftsQuery(question);
    if (!q) return [];
    rows = all<FactRow>(`${SELECT} FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid JOIN documents d ON d.id = f.doc_id
       WHERE facts_fts MATCH ? AND ${where} AND (f.flags IS NULL OR f.flags NOT LIKE '%malformed%')
       ORDER BY bm25(facts_fts) LIMIT ?`, q, ...params, limit * 8);
  }
  rows.sort((a, b) => (b.as_of ?? "").localeCompare(a.as_of ?? "") || a.tier - b.tier);
  // Value-diverse: the same value repeats on dozens of pages ("130+" × 40). Keep at most two rows per
  // distinct (key, value) so older values (85+ in 2025, 70+ in 2022–24) survive and the timeline is visible.
  const perValue = new Map<string, number>();
  const out: FactRow[] = [];
  for (const r of rows) {
    const k = `${r.key}|${valueKey(r.value)}`;
    const n = perValue.get(k) ?? 0;
    if (n >= 2) continue;
    perValue.set(k, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** "Ethereum, 130+ networks historically onboarded" and "130+" are the same value for diversity purposes. */
function valueKey(v: string): string {
  const num = v.match(/\$?\d[\d,.]*\s?[+%]?\s?(?:[MBK]\+?|million|billion)?/i);
  return (num ? num[0] : v).toLowerCase().replace(/[^a-z0-9+.%$]/g, "");
}

/** Map natural phrasing to ledger keys so "who runs the company" still hits `ceo`. */
function keyHints(q: string): string {
  const l = q.toLowerCase();
  const hints: string[] = [];
  if (/\bceo\b|chief exec|runs the company|head of the company|leads everstake/.test(l)) hints.push("ceo");
  if (/founder|founded|started|establish/.test(l)) hints.push("founder founded_year");
  if (/network|chain|blockchain/.test(l)) hints.push("networks_supported");
  if (/delegator|user|customer/.test(l)) hints.push("delegators");
  if (/staked|tvl|assets under/.test(l)) hints.push("total_staked_usd");
  if (/certif|soc 2|iso|compliance|audit/.test(l)) hints.push("certifications auditor");
  if (/uptime|availability/.test(l)) hints.push("uptime");
  if (/product|service|offer/.test(l)) hints.push("products");
  if (/legal entity|registered|incorporat|llc|inc\b/.test(l)) hints.push("legal_entity headquarters");
  if (/mcp|model context/.test(l)) hints.push("mcp_endpoint");
  if (/slash/.test(l)) hints.push("slashing_events");
  if (/validator/.test(l)) hints.push("validators");
  if (/team|employee|engineer/.test(l)) hints.push("team_size");
  return hints.join(" ");
}
