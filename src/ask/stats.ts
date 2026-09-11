// Corpus / dedup / instructions / cost numbers for the UI and REPORT.md.

import { all, one } from "../db.js";

export function stats() {
  const docs = one<any>(`SELECT COUNT(*) total, SUM(status='ok') ok, SUM(status='dropped') dropped,
    SUM(status='ok' AND duplicate_of IS NULL) canonical, SUM(status='ok' AND duplicate_of IS NOT NULL) aliases,
    SUM(status='ok' AND duplicate_of IS NULL AND published_at IS NOT NULL) dated,
    SUM(status='ok' AND duplicate_of IS NULL AND ai_directed=1) ai_directed FROM documents`);
  const byDomain = all(`SELECT domain, tier, COUNT(*) docs, SUM(duplicate_of IS NOT NULL) aliases, MIN(published_at) oldest, MAX(published_at) newest
    FROM documents WHERE status='ok' GROUP BY domain ORDER BY docs DESC`);
  const byCategory = all(`SELECT category, COUNT(*) docs FROM documents WHERE status='ok' AND duplicate_of IS NULL GROUP BY category ORDER BY docs DESC`);
  const byYear = all(`SELECT substr(published_at,1,4) year, COUNT(*) docs FROM documents WHERE status='ok' AND duplicate_of IS NULL AND published_at IS NOT NULL GROUP BY year ORDER BY year`);
  const dropped = all(`SELECT drop_reason reason, COUNT(*) n FROM documents WHERE status='dropped' GROUP BY reason ORDER BY n DESC`);
  const dedup = all(`SELECT dedup_method method, COUNT(*) n, ROUND(AVG(similarity),3) avg_similarity FROM documents WHERE duplicate_of IS NOT NULL GROUP BY method`);
  const chunks = one<any>(`SELECT COUNT(*) total, SUM(embedding IS NOT NULL) embedded, SUM(chars) chars FROM chunks`);
  const instructions = one<any>(`SELECT COUNT(*) sentences, COUNT(DISTINCT doc_id) documents FROM instructions`);
  const facts = one<any>(`SELECT COUNT(*) total, COUNT(DISTINCT key) keys, SUM(flags LIKE '%malformed%') malformed FROM facts`);
  const cost = all(`SELECT stage, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(cache_read_tokens) cache_read, ROUND(SUM(cost_usd),4) cost_usd, SUM(ok=0) errors
    FROM llm_calls GROUP BY stage, model ORDER BY cost_usd DESC`);
  const questions = one<any>(`SELECT COUNT(*) n, ROUND(AVG(cost_usd),5) avg_cost_usd, ROUND(AVG(latency_ms)) avg_latency_ms FROM questions_log WHERE status IN ('answered','no_reliable_answer')`);
  return { documents: docs, by_domain: byDomain, by_category: byCategory, by_year: byYear, dropped, dedup, chunks, instructions, facts, cost, questions };
}

export function dedupClusters(limit = 200) {
  return all(`SELECT a.id alias_id, a.url alias_url, a.dedup_method method, a.similarity, c.id canonical_id, c.url canonical_url, c.tier, c.published_at
    FROM documents a JOIN documents c ON c.id = a.duplicate_of ORDER BY c.id, a.id LIMIT ?`, limit);
}

export function instructionsFound(limit = 500) {
  return all(`SELECT i.id, i.sentence, i.pattern, d.id doc_id, d.url, d.title, d.ai_directed FROM instructions i JOIN documents d ON d.id = i.doc_id ORDER BY d.ai_directed DESC, d.id, i.chunk_idx LIMIT ?`, limit);
}
