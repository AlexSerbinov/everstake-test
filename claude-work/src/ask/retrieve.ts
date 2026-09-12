// Hybrid retrieval with explainable ranking.
//   BM25 (FTS5) top-N  ∪  cosine top-N  →  Reciprocal Rank Fusion
//   score = rrf × recency(published_at) × authority(tier, ai_directed)
// Every number is kept on the candidate so the UI can show WHY a chunk won.
//
// Pipeline position: crawl → dedup → index → facts → **retrieve** → answer → eval.
// This is the last point at which a page can influence an answer: the answer layer only ever
// sees what `selected` contains. Rank the wrong chunk first and no gate downstream can recover
// — gates can refuse an answer, they cannot find evidence that was never retrieved. The two
// failure modes worth naming: dropping first-party pages (the system answers from press
// releases) and letting a stale but keyword-perfect page outrank a current one (the CEO trap).

import { getConfig } from "../config.js";
import { all, blobToFloats, dbEpoch } from "../db.js";
import { cosine, embed, embeddingsEnabled } from "../embeddings.js";

/**
 * Categories whose undated pages are "live" (they describe the present as of the fetch).
 * An /about, a docs page or a repo README carries no publication date not because it is old
 * but because it is continuously true. Treating it as merely "undated" would let a year-old
 * press release outrank it on recency — which is exactly how the CEO trap is sprung.
 */
const LIVE_CATEGORIES = new Set(["site", "docs", "code"]);

/** One retrieved chunk plus every factor that produced its score, so the ranking is auditable. */
export interface Candidate {
  chunk_id: number;
  doc_id: number;
  url: string;
  title: string;
  published_at: string | null;
  /** 1 first-party · 2 press/third-party · 3 transcripts and social. */
  tier: number;
  domain: string;
  /** 1 when the whole page is addressed to AI assistants (/llms.txt, /ai-info). */
  ai_directed: number;
  category: string;
  fetched_at: string;
  date_kind: "published" | "live" | "undated";
  /** The date ranking actually uses: `published_at`, or the fetch date for a live page. */
  effective_date: string | null;
  text: string;
  /** Position in the BM25 list (1-based), or null when only the vector leg found it. */
  bm25_rank: number | null;
  vec_rank: number | null;
  cosine: number | null;
  rrf: number;
  recency: number;
  authority: number;
  score: number;
  /** Why this chunk made the final cut — "top" score, or filled a missing year. */
  selected_by?: "top" | "date-diverse";
}

/** One row of the fact ledger, joined to the document it was extracted from. */
export interface FactRow {
  id: number;
  key: string;
  value: string;
  /** The date the value was true, which is not the same as the page's publication date. */
  as_of: string | null;
  quote: string;
  confidence: number;
  /** Extraction problems, e.g. "malformed_number" — flagged rows never reach an answer. */
  flags: string | null;
  doc_id: number;
  url: string;
  title: string;
  tier: number;
  published_at: string | null;
  ai_directed: number;
}

export interface Retrieval {
  /** Everything the two legs found, ranked — the UI's "why" table. */
  candidates: Candidate[];
  /** What the answer layer actually receives. */
  selected: Candidate[];
  facts: FactRow[];
  vector_used: boolean;
  fts_query: string;
}

// Stop words are dropped from the FTS query because the terms are OR-ed: leaving "how", "many"
// or "the" in would match nearly every chunk in the corpus and flatten the BM25 ordering.
const STOP = new Set("a an the of in on at to for and or is are was were be been do does did how what which who whom when where why has have had it its this that these those with from by as about over after before than into up out many much more most any some such".split(" "));

/**
 * A natural question turned into an FTS5 MATCH expression: `"networks" OR "everstake"`.
 * OR rather than AND because a question rarely uses the page's wording — requiring every term
 * would return nothing, and BM25 already rewards chunks that match more of them. Terms are
 * quoted so FTS5 treats them as literals rather than as its own operators (`AND`, `NEAR`, `*`).
 * An all-stop-word question yields "", which the caller treats as "retrieve nothing" rather
 * than as "match everything".
 */
export function ftsQuery(question: string): string {
  // Keep letters, digits, apostrophes and hyphens: "everstake's" and "soc-2" are single terms.
  // Single characters go too — a stray "a" or "5" matches everywhere and means nothing.
  const terms = question.toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1 && !STOP.has(term));
  const uniqueTerms = [...new Set(terms)];
  // The inner quote strip stops a term from closing its own quotes and injecting FTS5 syntax.
  return uniqueTerms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
}

// The embedding matrix, held in memory because cosine search is a full scan over every chunk.
// Invalidated on chunk count OR db epoch: the count alone misses a re-index that replaced the
// same number of chunks, and `dbEpoch()` alone misses embeddings being backfilled in place.
let vecCache: { count: number; epoch: number; rows: { id: number; vector: Float32Array }[] } | null = null;
function chunkVectors() {
  const count = (all<{ n: number }>("SELECT COUNT(*) n FROM chunks WHERE embedding IS NOT NULL")[0]?.n) ?? 0;
  if (!vecCache || vecCache.count !== count || vecCache.epoch !== dbEpoch()) {
    const rows = all<{ id: number; embedding: Uint8Array }>("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL");
    // Decoded once here rather than per query: the BLOB → Float32Array conversion is the
    // expensive part of a cosine scan, the dot products themselves are cheap.
    vecCache = { count, epoch: dbEpoch(), rows: rows.map((row) => ({ id: row.id, vector: blobToFloats(row.embedding) })) };
  }
  return vecCache.rows;
}

/**
 * The corpus-wide WHERE clause, applied in SQL so an excluded document never becomes a
 * candidate at all — filtering after ranking would shrink the result set below the configured
 * top-N and silently return fewer sources than asked for.
 *
 * `status='ok'` drops pages that failed to fetch or parse; `duplicate_of IS NULL` drops
 * syndicated copies, which is what stops nine reprints of one press release outvoting one
 * first-party page.
 */
function filterSql(alias = "d") {
  const filters = getConfig().filters;
  const parts = [`${alias}.status='ok'`, `${alias}.duplicate_of IS NULL`];
  const params: any[] = [];
  if (filters.include_tiers?.length) {
    parts.push(`${alias}.tier IN (${filters.include_tiers.map(() => "?").join(",")})`);
    params.push(...filters.include_tiers);
  }
  // KNOWN LIMITATION: `%<value>` is an unanchored suffix match, so excluding "wire.org" also
  // excludes "chainwire.org". Pinned as-is by retrieve.test.ts; a fix would need `domain = ?
  // OR domain LIKE '%.' || ?` and a test update, so it is a behaviour change, not a tidy-up.
  for (const domain of filters.excluded_domains ?? []) {
    parts.push(`${alias}.domain NOT LIKE ?`);
    params.push(`%${domain}`);
  }
  // An undated document survives a year floor: the filter can only reject dates it can compare,
  // and dropping undated pages here would remove every evergreen /about and /docs page.
  if (filters.min_published_year) {
    parts.push(`(${alias}.published_at IS NULL OR ${alias}.published_at >= ?)`);
    params.push(`${filters.min_published_year}-01-01`);
  }
  return { where: parts.join(" AND "), params };
}

/**
 * Old facts about a fast-moving company are usually wrong, so score decays with age.
 *
 * Half-life rather than a cliff (`recency_half_life_days`, 365): a 2024 architecture post is
 * still the best source on architecture even when a 2026 press release exists, so age should
 * cost a source its lead, not its place in the list. The floor (`recency_floor`, 0.3) is the
 * other half of that: without it a 2018 page would decay towards zero and the corpus would
 * lose its history entirely — and "how has X changed since 2022" is one of the question shapes
 * this system is graded on. An undated document gets a flat `undated_recency` (0.6) rather than
 * a decayed value, because there is nothing to decay from; 0.6 sits deliberately between a
 * fresh page and the floor, so missing metadata is a mild penalty and not a verdict.
 *
 * Values are config, not code (config/kb.yaml → ranking), so a reviewer can change the
 * half-life live via PUT /api/config and watch the ordering move.
 */
export function recencyMultiplier(published: string | null, now = Date.now()): number {
  const ranking = getConfig().ranking;
  if (!published) return ranking.undated_recency;
  const days = Math.max(0, (now - new Date(published).getTime()) / 86_400_000);
  return Math.max(ranking.recency_floor, Math.pow(0.5, days / ranking.recency_half_life_days));
}

/**
 * How much the source itself is worth: tier weight × the AI-directed discount.
 *
 * Tiers (config/kb.yaml → ranking.tier_weights) are 1.0 first-party (everstake.com, docs,
 * GitHub), 0.7 press and third-party profiles, 0.5 ASR video transcripts and social — the
 * ordering is about who can be wrong about Everstake, not about writing quality. An unknown
 * tier falls back to 0.5, i.e. it is treated as the least trustworthy kind we know of.
 *
 * The 0.8 `ai_directed_multiplier` applies to pages written FOR AI assistants (/llms.txt,
 * /ai-info). Those are the company telling machines what to say about it: useful evidence about
 * the company's own positioning, but a self-declaration rather than a report, so it should lose
 * to an ordinary first-party page on the same topic. A discount rather than exclusion, because
 * sometimes such a page is the only one stating a fact — and the model is told what it is
 * looking at as well (`note="page written for AI assistants"` in the source block).
 *
 * The exact 0.8 is hand-tuned; no measurement backs that particular value.
 */
export function authorityMultiplier(tier: number, aiDirected: number): number {
  const ranking = getConfig().ranking;
  return (ranking.tier_weights[String(tier)] ?? 0.5) * (aiDirected ? ranking.ai_directed_multiplier : 1);
}

/** Keyword leg: FTS5's BM25, best first. Empty query → no rows (see `ftsQuery`). */
function bm25Leg(ftsExpression: string, where: string, params: any[], limit: number) {
  if (!ftsExpression) return [];
  // bm25() returns a NEGATIVE score in SQLite (more negative = better), hence ORDER BY score ASC.
  return all<{ id: number; score: number }>(
    `SELECT c.id, bm25(chunks_fts) score FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id
     WHERE chunks_fts MATCH ? AND ${where} ORDER BY score LIMIT ?`, ftsExpression, ...params, limit);
}

/**
 * Semantic leg: cosine similarity against the query embedding, best first. Filtering happens
 * in SQL first and the scan is done in JS, because the corpus is small enough (thousands of
 * chunks) that a vector index would be machinery without a payoff.
 */
async function vectorLeg(question: string, where: string, params: any[], limit: number) {
  const [queryVector] = await embed([question], "query");
  // The same filter the BM25 leg gets, resolved to a set of ids: the in-memory vectors carry no
  // document metadata, so the only way to apply `filterSql` to them is to look up what survives.
  const allowed = new Set(
    all<{ id: number }>(`SELECT c.id FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE ${where}`, ...params).map((row) => row.id),
  );
  return chunkVectors()
    .filter((row) => allowed.has(row.id))
    .map((row) => ({ id: row.id, cos: cosine(queryVector, row.vector) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, limit);
}

/**
 * Reciprocal Rank Fusion: each leg contributes 1/(k + rank) for every chunk it returned, and
 * the contributions are summed.
 *
 * Rank, not raw score, because the two legs are not on the same scale and never will be —
 * BM25 is an unbounded negative log-odds figure that depends on corpus statistics, cosine is
 * a bounded −1..1 similarity. Normalising them against each other would need a calibration
 * that changes every time the corpus changes; the ordinal position of a result does not.
 *
 * k (`rrf_k`, 60 — the value from the original RRF paper, unchanged) flattens the head of each
 * list: with k=60 the first result contributes 1/61 and the fifth 1/65, so a chunk that both
 * legs rank in their top few beats a chunk that one leg ranks first and the other misses
 * entirely. That is the intended bias — agreement between two different notions of relevance
 * is stronger evidence than one leg's confidence.
 *
 * The consequence to be aware of: RRF values span a narrow band (0.0164…0.0149 across a
 * 40-deep BM25 list), so the recency and authority multipliers, not keyword density, decide
 * the final order. That is deliberate.
 */
function fuseRanks(
  bm25: { id: number; score: number }[],
  vec: { id: number; cos: number }[],
  k: number,
): Map<number, Partial<Candidate>> {
  const byId = new Map<number, Partial<Candidate>>();
  bm25.forEach((row, i) => {
    byId.set(row.id, { chunk_id: row.id, bm25_rank: i + 1, rrf: 1 / (k + i + 1) });
  });
  vec.forEach((row, i) => {
    const fused = byId.get(row.id) ?? { chunk_id: row.id, rrf: 0 };
    fused.vec_rank = i + 1;
    fused.cosine = Number(row.cos.toFixed(4));
    fused.rrf = (fused.rrf ?? 0) + 1 / (k + i + 1);
    byId.set(row.id, fused);
  });
  return byId;
}

/**
 * Attaches the ranking factors to each fused chunk and sorts by the product.
 *
 * KNOWN LIMITATION (not a bug, but a trap): `rrf` and `recency` are rounded for display while
 * `score` is computed from the RAW values, so re-multiplying the three fields stored on a
 * Candidate does not always reproduce `score` — it can be off by an ulp of display precision.
 * Anyone "simplifying" this by recomputing the score from the stored factors will change the
 * ordering. retrieve.test.ts pins exactly this.
 */
function scoreCandidates(rows: any[], fused: Map<number, Partial<Candidate>>): Candidate[] {
  return rows
    .map((row) => {
      const fusedRanks = fused.get(row.chunk_id)!;
      // Evergreen site/docs pages without a publication date describe the state at fetch time
      // ("live page"); a dated announcement older than that must not override them.
      const isLivePage = !row.published_at && LIVE_CATEGORIES.has(row.category);
      row.date_kind = row.published_at ? "published" : isLivePage ? "live" : "undated";
      row.effective_date = row.published_at ?? (isLivePage ? row.fetched_at.slice(0, 10) : null);
      const recency = recencyMultiplier(row.effective_date);
      const authority = authorityMultiplier(row.tier, row.ai_directed);
      const rrf = fusedRanks.rrf ?? 0;
      return {
        ...row,
        bm25_rank: fusedRanks.bm25_rank ?? null,
        vec_rank: fusedRanks.vec_rank ?? null,
        cosine: fusedRanks.cosine ?? null,
        rrf: Number(rrf.toFixed(5)),
        recency: Number(recency.toFixed(3)),
        authority,                                       // stored raw, unlike the other three
        score: Number((rrf * recency * authority).toFixed(5)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The final cut: the `final_top` highest scores, then up to `date_diverse_extra` more chosen
 * for their DATE rather than their score.
 *
 * The top-k is deliberately not the k highest scores, because ranking by recency makes the
 * head of the list clump into the present: for "how has X changed", ten chunks that all say
 * "130+ networks (2026)" answer nothing, while one 2022 chunk saying "70+" turns the same
 * question into a timeline. So each extra slot goes to the best-scoring chunk from a year not
 * yet represented, and from a document not yet used — the second condition matters because a
 * single long page would otherwise supply several "different" years from its own history
 * section and buy no new evidence.
 *
 * Chunks with no effective date are skipped here: they cannot fill a year gap, and they are
 * already eligible for the score-ranked head above.
 */
function selectDateDiverse(candidates: Candidate[], finalTop: number, extra: number): Candidate[] {
  // Copies, so `selected_by` is stamped on the selection and not on the candidate list the UI
  // shows as the raw ranking. retrieve.test.ts pins that distinction.
  const selected: Candidate[] = candidates.slice(0, finalTop).map((candidate) => ({ ...candidate, selected_by: "top" as const }));
  const usedDocs = new Set(selected.map((candidate) => candidate.doc_id));
  const years = new Set(selected.map((candidate) => candidate.effective_date?.slice(0, 4)).filter(Boolean));
  for (const candidate of candidates.slice(finalTop)) {
    if (selected.length >= finalTop + extra) break;
    const year = candidate.effective_date?.slice(0, 4);
    if (!year || years.has(year) || usedDocs.has(candidate.doc_id)) continue;
    years.add(year);
    usedDocs.add(candidate.doc_id);
    selected.push({ ...candidate, selected_by: "date-diverse" });
  }
  return selected;
}

/**
 * The one entry point the answer layer uses — both `ask()` and the agent's `search_corpus`
 * tool call this, so a source scored 0.031 means the same thing on both paths.
 *
 * Order of operations matters: filter in SQL → two legs → fuse → multiply → select. Fusing
 * before multiplying is what keeps the explanation legible, since every candidate then carries
 * its own rrf/recency/authority and the UI can show why one chunk beat another.
 */
export async function retrieve(question: string): Promise<Retrieval> {
  const cfg = getConfig();
  const { where, params } = filterSql();
  const ftsExpression = ftsQuery(question);

  const bm25 = bm25Leg(ftsExpression, where, params, cfg.retrieval.bm25_top);

  const vectorUsed = embeddingsEnabled();
  const vec = vectorUsed ? await vectorLeg(question, where, params, cfg.retrieval.vector_top) : [];

  const fused = fuseRanks(bm25, vec, cfg.retrieval.rrf_k);
  if (fused.size === 0) {
    // Neither leg matched. Fact rows are still worth returning: the ledger is searched by key,
    // so "who is the CEO" can be answerable when no chunk matched the question's wording.
    return { candidates: [], selected: [], facts: factsFor(question), vector_used: vectorUsed, fts_query: ftsExpression };
  }

  const ids = [...fused.keys()];
  const rows = all<any>(
    `SELECT c.id chunk_id, c.doc_id, c.text, d.url, d.title, d.published_at, d.fetched_at, d.category, d.tier, d.domain, d.ai_directed
     FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${ids.map(() => "?").join(",")})`, ...ids);

  const candidates = scoreCandidates(rows, fused);
  const selected = selectDateDiverse(candidates, cfg.retrieval.final_top, cfg.retrieval.date_diverse_extra);
  return { candidates, selected, facts: factsFor(question), vector_used: vectorUsed, fts_query: ftsExpression };
}

/**
 * Fact ledger rows that match the question (FTS over key+value+quote), newest first.
 *
 * The ledger exists because a chunk can only show what one page said on one day; a question
 * like "how many networks does Everstake support" needs the whole series (70 in 2022 → 85 in
 * 2025 → 130+ in 2026) to be answered honestly, and reconstructing that from prose is exactly
 * the job a model does badly.
 */
export function factsFor(question: string, limit = 14): FactRow[] {
  const rows = ledgerRows(question, limit);
  // Newest first, then most authoritative — so the current value leads and, where two sources
  // give the same date, the first-party one is the row that survives the diversity cap below.
  rows.sort((a, b) => (b.as_of ?? "").localeCompare(a.as_of ?? "") || a.tier - b.tier);
  return capRepeatedValues(rows, limit);
}

const FACT_SELECT = `SELECT f.id, f.key, f.value, f.as_of, f.quote, f.confidence, f.flags, d.id doc_id, d.url, d.title, d.tier, d.published_at, d.ai_directed`;
// Rows the extractor could not parse cleanly (the corpus's corrupted "735,,,," lives here) are
// excluded in SQL, so a malformed value can never reach an answer however recent it is.
const NOT_MALFORMED = `(f.flags IS NULL OR f.flags NOT LIKE '%malformed%')`;

/** Raw ledger rows for a question — by key when the question names one, by FTS otherwise. */
function ledgerRows(question: string, limit: number): FactRow[] {
  const hinted = keyHints(question).split(" ").filter(Boolean);
  if (hinted.length) {
    // the question names a ledger key → take that key's whole history, not an FTS sample of it
    const { where, params } = filterSql();
    return all<FactRow>(`${FACT_SELECT} FROM facts f JOIN documents d ON d.id = f.doc_id
       WHERE f.key IN (${hinted.map(() => "?").join(",")}) AND ${where} AND ${NOT_MALFORMED}`, ...hinted, ...params);
  }
  const ftsExpression = ftsQuery(question);
  if (!ftsExpression) return [];
  const { where, params } = filterSql();
  // limit × 8 because the diversity cap below throws most of these away; over-fetching here is
  // what stops the cap from returning three rows when fourteen were asked for.
  return all<FactRow>(`${FACT_SELECT} FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid JOIN documents d ON d.id = f.doc_id
     WHERE facts_fts MATCH ? AND ${where} AND ${NOT_MALFORMED}
     ORDER BY bm25(facts_fts) LIMIT ?`, ftsExpression, ...params, limit * 8);
}

/**
 * Value-diverse: the same value repeats on dozens of pages ("130+" × 40). Keep at most two rows
 * per distinct (key, value) so older values (85+ in 2025, 70+ in 2022–24) survive and the
 * timeline is visible. Two rather than one, so a value can still show two independent sources.
 */
function capRepeatedValues(rows: FactRow[], limit: number): FactRow[] {
  const MAX_ROWS_PER_VALUE = 2;
  const seenPerValue = new Map<string, number>();
  const out: FactRow[] = [];
  for (const row of rows) {
    const identity = `${row.key}|${valueKey(row.value)}`;
    const seen = seenPerValue.get(identity) ?? 0;
    if (seen >= MAX_ROWS_PER_VALUE) continue;
    seenPerValue.set(identity, seen + 1);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** "Ethereum, 130+ networks historically onboarded" and "130+" are the same value for diversity purposes. */
function valueKey(value: string): string {
  // Matches the first figure with its optional currency, sign and magnitude word:
  // "$7B+", "130+", "99.98%", "1.6 million". Falls back to the whole string when there is no number.
  const firstNumber = value.match(/\$?\d[\d,.]*\s?[+%]?\s?(?:[MBK]\+?|million|billion)?/i);
  return (firstNumber ? firstNumber[0] : value).toLowerCase().replace(/[^a-z0-9+.%$]/g, "");
}

/**
 * Map natural phrasing to ledger keys so "who runs the company" still hits `ceo`.
 *
 * A hand-written table rather than a model call: it runs on every question, must be instant and
 * free, and a wrong guess here silently swaps which key's history gets returned. The patterns
 * are deliberately loose (a hint that misses just falls back to FTS over the ledger) and the
 * list is the obvious place to extend when a new ledger key is added.
 */
function keyHints(question: string): string {
  const lower = question.toLowerCase();
  const hints: string[] = [];
  if (/\bceo\b|chief exec|runs the company|head of the company|leads everstake/.test(lower)) hints.push("ceo");
  if (/founder|founded|started|establish/.test(lower)) hints.push("founder founded_year");
  if (/network|chain|blockchain/.test(lower)) hints.push("networks_supported");
  if (/delegator|user|customer/.test(lower)) hints.push("delegators");
  if (/staked|tvl|assets under/.test(lower)) hints.push("total_staked_usd");
  if (/certif|soc 2|iso|compliance|audit/.test(lower)) hints.push("certifications auditor");
  if (/uptime|availability/.test(lower)) hints.push("uptime");
  if (/product|service|offer/.test(lower)) hints.push("products");
  if (/legal entity|registered|incorporat|llc|inc\b/.test(lower)) hints.push("legal_entity headquarters");
  if (/mcp|model context/.test(lower)) hints.push("mcp_endpoint");
  if (/slash/.test(lower)) hints.push("slashing_events");
  if (/validator/.test(lower)) hints.push("validators");
  if (/team|employee|engineer/.test(lower)) hints.push("team_size");
  // Space-joined (some entries above are two keys at once) and split by the caller.
  return hints.join(" ");
}
