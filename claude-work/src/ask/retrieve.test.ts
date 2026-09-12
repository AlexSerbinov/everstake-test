// The ranking heart of the system. Everything here runs against a throw-away in-memory index
// with embeddings switched off, so BM25 → RRF → recency × authority → selection is fully
// deterministic and the numbers below are the real ones the pipeline produces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, setDbPath } from "../db.js";
import { env, getConfig, resetConfigOverrides, setConfigOverrides } from "../config.js";

setDbPath(":memory:");
// BM25-only: with a vector provider configured, `retrieve` would try to embed the query.
(env as any).embeddingsProvider = "none";

const { authorityMultiplier, factsFor, ftsQuery, recencyMultiplier, retrieve } = await import("./retrieve.js");

// doc id, url, domain, tier, category, published_at, ai_directed, status, duplicate_of
const DOCS: [number, string, string, number, string, string | null, number, string, number | null][] = [
  [1, "https://everstake.com/about", "everstake.com", 1, "site", null, 0, "ok", null],
  [2, "https://chainwire.org/pr", "chainwire.org", 2, "news", "2026-08-01", 0, "ok", null],
  [3, "https://everstake.com/resources/blog/old", "everstake.com", 1, "blog", "2024-01-01", 0, "ok", null],
  [4, "https://everstake.com/ai-info", "everstake.com", 1, "site", null, 1, "ok", null],
  [5, "https://x.test/dropped", "x.test", 1, "site", "2026-09-01", 0, "dropped", null],
  [6, "https://mirror.test/copy", "mirror.test", 2, "news", "2026-09-01", 0, "ok", 2],
  [7, "https://youtube.com/v", "youtube.com", 3, "video", "2022-05-05", 0, "ok", null],
  [8, "https://press.test/undated", "press.test", 2, "news", null, 0, "ok", null],
  [9, "https://everstake.com/resources/blog/2023", "everstake.com", 1, "blog", "2023-06-06", 0, "ok", null],
];
for (const [id, url, domain, tier, category, published, ai, status, dup] of DOCS) {
  run(`INSERT INTO documents (id, source_id, url, domain, category, tier, title, published_at, fetched_at, ai_directed, status, duplicate_of)
       VALUES (?,'s',?,?,?,?,'Title',?,'2026-09-10T08:00:00Z',?,?,?)`, id, url, domain, category, tier, published, ai, status, dup);
  // identical shape and length in every chunk, so BM25 cannot separate them and RRF order
  // falls back to chunk id — which keeps this test's expectations stable
  run(`INSERT INTO chunks (doc_id, idx, text, chars) VALUES (?,0,?,40)`, id, `Everstake supports many networks. Document ${id}.`);
}

const FACTS: [number, string, string, string | null, string, string | null][] = [
  [1, "ceo", "Sergii Vasylchuk", "2026-09-01", "Sergii Vasylchuk is the CEO of Everstake", null],
  [2, "ceo", "Sergii Vasylchuk", "2025-01-01", "CEO Sergii Vasylchuk of Everstake said", null],
  [3, "ceo", "Someone Else", "2023-01-01", "Someone Else, CEO", null],
  [1, "ceo", "Sergii Vasylchuk", "2024-01-01", "a third page repeating the same value", null],
  [2, "ceo", "Bogus", "2026-09-05", "bogus", "malformed_number,other"],
  [1, "networks_supported", "130+", "2026-09-01", "supports 130+ networks", null],
  [2, "networks_supported", "Ethereum, 130+ networks historically onboarded", "2026-08-01", "quote", null],
  [3, "networks_supported", "130+", "2024-01-01", "quote", null],
  [1, "uptime", "99.98%", null, "uptime 99.98%", null],
  [1, "custody_model", "non-custodial", "2026-09-01", "Everstake is non-custodial and never holds keys", null],
];
for (const f of FACTS) run(`INSERT INTO facts (doc_id,key,value,as_of,as_of_source,quote,confidence,flags) VALUES (?,?,?,?,'text',?,0.9,?)`, ...f);

/** Retrieval knobs shrunk so selection is observable in a nine-document index. */
const RETRIEVAL = { final_top: 2, date_diverse_extra: 2 };
const withDefaults = () => setConfigOverrides({ retrieval: { ...resetConfigOverrides().retrieval, ...RETRIEVAL } });
withDefaults();

// --- query building -----------------------------------------------------------------------

test("the FTS query drops stop words and one-character tokens, dedupes, and ORs quoted terms", () => {
  assert.equal(ftsQuery("How many networks does Everstake support?"), '"networks" OR "everstake" OR "support"');
  assert.equal(ftsQuery("MCP MCP mcp"), '"mcp"', "case-folded and deduped");
  assert.equal(ftsQuery("a b cc"), '"cc"', "tokens of length 1 are dropped");
  assert.equal(ftsQuery("the of and is"), "", "an all-stop-word question produces no query at all");
  // apostrophes and hyphens survive inside the quoted term; a stray double quote is removed
  assert.equal(ftsQuery('Everstake\'s SOC-2 "audit"'), '"everstake\'s" OR "soc-2" OR "audit"');
});

test("an empty FTS query short-circuits the whole retrieval instead of matching everything", async () => {
  const r = await retrieve("the of and is");
  assert.deepEqual([r.candidates, r.selected, r.facts], [[], [], []]);
  assert.equal(r.fts_query, "");
  assert.equal(r.vector_used, false);
});

// --- the multipliers ----------------------------------------------------------------------

test("authority is the tier weight times the AI-directed discount, unrounded", () => {
  assert.equal(authorityMultiplier(1, 0), 1);
  assert.equal(authorityMultiplier(2, 0), 0.7);
  assert.equal(authorityMultiplier(3, 0), 0.5);
  assert.equal(authorityMultiplier(99, 0), 0.5, "an unknown tier falls back to 0.5, the same as tier 3");
  assert.equal(authorityMultiplier(1, 1), 0.8);
  // unlike rrf/recency/score, authority is stored raw — float noise and all
  assert.equal(authorityMultiplier(2, 1), 0.5599999999999999);
});

test("an undated document gets the flat undated multiplier, not a decayed one", () => {
  assert.equal(recencyMultiplier(null), getConfig().ranking.undated_recency);
  assert.equal(recencyMultiplier(null), 0.6);
});

// --- ranking ------------------------------------------------------------------------------

test("dropped documents and dedup aliases never become candidates", async () => {
  const r = await retrieve("How many networks does Everstake support?");
  const ids = r.candidates.map((c) => c.doc_id);
  assert.deepEqual(ids.slice().sort((a, b) => a - b), [1, 2, 3, 4, 7, 8, 9]);
  assert.equal(ids.includes(5), false, "status='dropped'");
  assert.equal(ids.includes(6), false, "duplicate_of is set");
});

// an evergreen /about page carries no publication date but describes the present; treating it
// as "undated" would let a year-old press release outrank it on recency
test("an undated site/docs/code page is 'live' and dates from its fetch, other undated pages do not", async () => {
  const by = new Map((await retrieve("How many networks does Everstake support?")).candidates.map((c) => [c.doc_id, c]));
  assert.deepEqual([by.get(1)!.date_kind, by.get(1)!.effective_date], ["live", "2026-09-10"]);
  assert.deepEqual([by.get(8)!.date_kind, by.get(8)!.effective_date], ["undated", null], "category 'news' is not a live category");
  assert.deepEqual([by.get(2)!.date_kind, by.get(2)!.effective_date], ["published", "2026-08-01"]);
  assert.equal(by.get(1)!.recency, Number(recencyMultiplier("2026-09-10").toFixed(3)));
  assert.equal(by.get(8)!.recency, 0.6);
});

test("score is rrf × recency × authority and sorts the candidates", async () => {
  const r = await retrieve("How many networks does Everstake support?");
  for (const c of r.candidates) {
    // RRF is 1/(k + rank) with k=60, so the whole BM25 leg spans 0.0164…0.0149 — authority and
    // recency, not keyword density, decide the order
    const rawRrf = 1 / (60 + c.bm25_rank!);
    assert.equal(c.rrf, Number(rawRrf.toFixed(5)), `doc ${c.doc_id} rrf`);
    assert.equal(c.recency, Number(recencyMultiplier(c.effective_date).toFixed(3)), `doc ${c.doc_id} recency`);
    assert.equal(c.authority, authorityMultiplier(c.tier, c.ai_directed), `doc ${c.doc_id} authority`);
    assert.ok(Math.abs(c.score - rawRrf * recencyMultiplier(c.effective_date) * c.authority) < 1e-5, `doc ${c.doc_id} score`);
    assert.equal(c.vec_rank, null, "no vector leg without embeddings");
    assert.equal(c.cosine, null);
  }
  for (let i = 1; i < r.candidates.length; i++) assert.ok(r.candidates[i - 1].score >= r.candidates[i].score, "sorted by score, descending");
});

// the exposed rrf/recency are rounded for display but the score is computed from the raw
// values, so re-multiplying what the UI shows does NOT always reproduce the score
test("the score is computed before rounding, so the displayed factors cannot always reproduce it", async () => {
  const by = new Map((await retrieve("How many networks does Everstake support?")).candidates.map((c) => [c.doc_id, c]));
  const live = by.get(1)!;
  assert.equal(live.score, Number((1 / 61 * recencyMultiplier("2026-09-10") * 1).toFixed(5)));
  // whether re-multiplying the rounded factors lands on the same 5 decimals depends on today's
  // date (recency decays daily), so only assert that it is within one unit of display
  assert.ok(Math.abs(live.score - live.rrf * live.recency * live.authority) < 0.00002, "rounded factors reproduce the score within one ulp of display");

  // documents whose recency is pinned to a constant (undated, or already at the floor) are exact
  assert.equal(by.get(8)!.score, Number((1 / 66 * 0.6 * 0.7).toFixed(5)));
  assert.equal(by.get(3)!.score, Number((1 / 63 * 0.3 * 1).toFixed(5)));
});

// the CEO trap in ranking form: the first-party page wins even though a tier-2 press release
// is a better keyword match and only a few weeks older
test("authority and recency reorder the BM25 list rather than following it", async () => {
  const r = await retrieve("How many networks does Everstake support?");
  assert.deepEqual(r.candidates.map((c) => c.doc_id), [1, 4, 2, 8, 3, 9, 7]);
  assert.deepEqual(r.candidates.map((c) => c.bm25_rank), [1, 4, 2, 6, 3, 7, 5], "BM25 alone would have ordered them 1,2,3,4,5,6,7");
  const [about, aiInfo] = r.candidates;
  assert.ok(about.score > aiInfo.score, "the /ai-info page is the same tier and date but discounted for being written for machines");
});

test("selection takes the top N, then one extra chunk per unseen year from an unseen document", async () => {
  const r = await retrieve("How many networks does Everstake support?");
  assert.deepEqual(r.selected.map((c) => [c.doc_id, c.selected_by, c.effective_date]), [
    [1, "top", "2026-09-10"],
    [4, "top", "2026-09-10"],
    [3, "date-diverse", "2024-01-01"],
    [9, "date-diverse", "2023-06-06"],
  ]);
  // doc 2 is the third-best candidate but its year (2026) is already represented, and doc 8 has
  // no effective date at all — both are skipped so the extra slots buy an actual timeline
  assert.equal(r.selected.some((c) => c.doc_id === 2 || c.doc_id === 8), false);
  assert.equal(r.selected.length, RETRIEVAL.final_top + RETRIEVAL.date_diverse_extra, "the extras are capped");
  assert.equal(r.candidates[0].selected_by, undefined, "selected_by is stamped on the copy, not on the candidate list");
});

test("the date-diverse pass stops as soon as the extra budget is spent", async () => {
  setConfigOverrides({ retrieval: { ...getConfig().retrieval, date_diverse_extra: 1 } });
  try {
    const r = await retrieve("How many networks does Everstake support?");
    assert.deepEqual(r.selected.map((c) => c.doc_id), [1, 4, 3]);
  } finally { withDefaults(); }
});

// --- filters ------------------------------------------------------------------------------

test("include_tiers and min_published_year are applied in SQL, before ranking", async () => {
  setConfigOverrides({ filters: { ...getConfig().filters, include_tiers: [1] } });
  try {
    const r = await retrieve("How many networks does Everstake support?");
    assert.deepEqual(r.candidates.map((c) => c.doc_id).sort((a, b) => a - b), [1, 3, 4, 9]);
  } finally { withDefaults(); }

  setConfigOverrides({ filters: { ...getConfig().filters, min_published_year: 2025 } });
  try {
    const r = await retrieve("How many networks does Everstake support?");
    // an undated page survives a year floor — the filter only rejects dates it can compare
    assert.deepEqual(r.candidates.map((c) => c.doc_id).sort((a, b) => a - b), [1, 2, 4, 8]);
  } finally { withDefaults(); }
});

// suspected bug, pinned as-is: excluded_domains becomes `domain NOT LIKE '%<value>'`, an
// unanchored suffix match, so excluding one domain silently excludes every domain ending in it
test("an excluded domain is matched as a bare suffix, so it also excludes unrelated hosts", async () => {
  setConfigOverrides({ filters: { ...getConfig().filters, excluded_domains: ["wire.org"] } });
  try {
    const r = await retrieve("How many networks does Everstake support?");
    assert.equal(r.candidates.some((c) => c.domain === "chainwire.org"), false, "'chainwire.org' ends with 'wire.org'");
  } finally { withDefaults(); }
});

// --- the fact ledger ----------------------------------------------------------------------

test("a question that names a ledger key returns that key's whole history, newest first", () => {
  const rows = factsFor("Who is the CEO of Everstake?");
  assert.deepEqual(rows.map((r) => [r.value, r.as_of]), [
    ["Sergii Vasylchuk", "2026-09-01"],
    ["Sergii Vasylchuk", "2025-01-01"],
    ["Someone Else", "2023-01-01"],
  ]);
  assert.equal(rows.every((r) => r.key === "ceo"), true, "the FTS sample is bypassed entirely");
});

test("rows flagged malformed never reach an answer, however recent they are", () => {
  // the malformed row is the NEWEST ceo row in the ledger; it must still not be returned
  assert.equal(factsFor("Who is the CEO of Everstake?").some((r) => r.value === "Bogus"), false);
});

// "130+" repeats on dozens of pages; without this cap the newest value would fill the budget
// and the older 85 / 70+ readings that make a timeline would never be shown
test("at most two rows survive per distinct key+value, comparing the number inside the value", () => {
  const rows = factsFor("How many networks does Everstake support?");
  assert.deepEqual(rows.map((r) => r.value), ["130+", "Ethereum, 130+ networks historically onboarded"]);
  assert.equal(rows.length, 2, "the third 130+ row is cut even though it is the only 2024 reading");
});

test("ledger rows sort by as_of descending, then by tier, and the limit is applied after diversity", () => {
  const rows = factsFor("Who is the CEO and how many networks?");
  assert.deepEqual(rows.map((r) => [r.key, r.as_of, r.tier]), [
    ["ceo", "2026-09-01", 1],
    ["networks_supported", "2026-09-01", 1],
    ["networks_supported", "2026-08-01", 2],
    ["ceo", "2025-01-01", 2],
    ["ceo", "2023-01-01", 1],
  ]);
  assert.deepEqual(factsFor("Who is the CEO of Everstake?", 2).map((r) => r.as_of), ["2026-09-01", "2025-01-01"]);
});

test("a question that names no ledger key falls back to full-text search over the ledger", () => {
  assert.deepEqual(factsFor("non-custodial keys").map((r) => r.key), ["custody_model"]);
  assert.deepEqual(factsFor("the of and is"), [], "no key hint and no searchable term → nothing");
});

test("a fact with no as_of still comes back, sorted to the end", () => {
  const rows = factsFor("What is the uptime?");
  assert.deepEqual(rows.map((r) => [r.key, r.as_of]), [["uptime", null]]);
});
