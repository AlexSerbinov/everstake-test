// Read-only reporting over the finished index: the numbers behind the UI's "Corpus" panel,
// the `kb stats` CLI command and every count quoted in REPORT.md.
//
// Pipeline position: this is a leaf. It runs AFTER crawl → dedup → index → facts and never
// writes anything, so nothing here can corrupt the corpus. What it CAN do is lie: every
// number a reviewer reads in REPORT.md comes from these queries, so a wrong `WHERE` clause
// here turns into a wrong claim in the write-up. The recurring trap is the difference between
// "documents we fetched" and "documents that count":
//   status='ok'            → fetched and parsed (excludes drops: 404s, too-short shells, …)
//   duplicate_of IS NULL   → the canonical copy (excludes syndicated aliases)
// A count that omits either qualifier inflates the corpus. `by_domain` deliberately keeps the
// aliases (it reports how much syndication each domain contributes); everything else drops them.

import { all, one } from "../db.js";

/** Every corpus/cost number the UI and REPORT.md quote, in one round of queries. */
export function stats() {
  // One row of totals. SUM(<predicate>) counts rows where the predicate is true — SQLite has no
  // COUNT(...) FILTER in the build we target, and this keeps it to a single table scan.
  const documents = one<any>(`SELECT COUNT(*) total, SUM(status='ok') ok, SUM(status='dropped') dropped,
    SUM(status='ok' AND duplicate_of IS NULL) canonical, SUM(status='ok' AND duplicate_of IS NOT NULL) aliases,
    SUM(status='ok' AND duplicate_of IS NULL AND published_at IS NOT NULL) dated,
    SUM(status='ok' AND duplicate_of IS NULL AND ai_directed=1) ai_directed FROM documents`);

  // Per-domain coverage and date span. Aliases are counted, not filtered out: the point of this
  // table is to show WHERE syndication comes from (one press release copied across nine hosts).
  const byDomain = all(`SELECT domain, tier, COUNT(*) docs, SUM(duplicate_of IS NOT NULL) aliases, MIN(published_at) oldest, MAX(published_at) newest
    FROM documents WHERE status='ok' GROUP BY domain ORDER BY docs DESC`);

  const byCategory = all(`SELECT category, COUNT(*) docs FROM documents WHERE status='ok' AND duplicate_of IS NULL GROUP BY category ORDER BY docs DESC`);

  // Documents per publication year — the histogram that shows the corpus is not all 2026.
  // Undated documents are excluded rather than bucketed as "unknown"; `documents.dated` above
  // is what tells you how many of them there are.
  const byYear = all(`SELECT substr(published_at,1,4) year, COUNT(*) docs FROM documents WHERE status='ok' AND duplicate_of IS NULL AND published_at IS NOT NULL GROUP BY year ORDER BY year`);

  // Why pages were thrown away (404, too little text, wrong content type …). Reviewers ask
  // "what did you drop and why" — this is the answer, not a hand-written list.
  const dropped = all(`SELECT drop_reason reason, COUNT(*) n FROM documents WHERE status='dropped' GROUP BY reason ORDER BY n DESC`);

  // Which dedup method caught each alias (exact hash / MinHash / containment) and how similar
  // the pair was — the evidence that the thresholds in config are doing real work.
  const dedup = all(`SELECT dedup_method method, COUNT(*) n, ROUND(AVG(similarity),3) avg_similarity FROM documents WHERE duplicate_of IS NOT NULL GROUP BY method`);

  const chunks = one<any>(`SELECT COUNT(*) total, SUM(embedding IS NOT NULL) embedded, SUM(chars) chars FROM chunks`);

  // Instruction sentences cut out of the text at index time (§5.4). Both numbers matter: how
  // many sentences were stripped, and how few distinct documents they came from.
  const instructions = one<any>(`SELECT COUNT(*) sentences, COUNT(DISTINCT doc_id) documents FROM instructions`);

  const facts = one<any>(`SELECT COUNT(*) total, COUNT(DISTINCT key) keys, SUM(flags LIKE '%malformed%') malformed FROM facts`);

  // Measured spend, per pipeline stage and model. `errors` counts failed calls, which are billed
  // as $0 here but explain gaps between call count and output tokens.
  const cost = all(`SELECT stage, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(cache_read_tokens) cache_read, ROUND(SUM(cost_usd),4) cost_usd, SUM(ok=0) errors
    FROM llm_calls GROUP BY stage, model ORDER BY cost_usd DESC`);

  // Answer-time averages. Rows logged with status 'error' (provider outages) are excluded so a
  // failed provider cannot flatter the average latency or deflate the average cost.
  const questions = one<any>(`SELECT COUNT(*) n, ROUND(AVG(cost_usd),5) avg_cost_usd, ROUND(AVG(latency_ms)) avg_latency_ms FROM questions_log WHERE status IN ('answered','no_reliable_answer')`);

  return { documents, by_domain: byDomain, by_category: byCategory, by_year: byYear, dropped, dedup, chunks, instructions, facts, cost, questions };
}

/**
 * Every alias → canonical pair, so "we deduped 118 pages" can be audited rather than believed.
 * Ordered by canonical id so copies of the same press release appear as one visual cluster.
 */
export function dedupClusters(limit = 200) {
  return all(`SELECT a.id alias_id, a.url alias_url, a.dedup_method method, a.similarity, c.id canonical_id, c.url canonical_url, c.tier, c.published_at
    FROM documents a JOIN documents c ON c.id = a.duplicate_of ORDER BY c.id, a.id LIMIT ?`, limit);
}

/**
 * The instruction sentences that were removed from the corpus, with the page they came from.
 * Pages flagged `ai_directed` sort first because they are the interesting ones: a whole page
 * addressed to machines (/llms.txt, /ai-info) rather than one stray sentence in a blog post.
 */
export function instructionsFound(limit = 500) {
  return all(`SELECT i.id, i.sentence, i.pattern, d.id doc_id, d.url, d.title, d.ai_directed FROM instructions i JOIN documents d ON d.id = i.doc_id ORDER BY d.ai_directed DESC, d.id, i.chunk_idx LIMIT ?`, limit);
}
