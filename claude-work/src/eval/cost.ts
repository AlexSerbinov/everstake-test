// Measured cost from llm_calls, plus the ×50 extrapolation with its arithmetic shown.

import { all, one } from "../db.js";

export function costReport(asJson = false) {
  const byStage = all<any>(`SELECT stage, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
      SUM(cache_read_tokens) cache_read_tokens, ROUND(SUM(cost_usd),5) cost_usd, ROUND(AVG(latency_ms)) avg_latency_ms, SUM(ok=0) errors
    FROM llm_calls GROUP BY stage, model ORDER BY stage`);
  const docs = one<any>(`SELECT SUM(status='ok' AND duplicate_of IS NULL) canonical, SUM(status='ok') fetched FROM documents`);
  const chunks = one<any>(`SELECT COUNT(*) n, SUM(chars) chars FROM chunks`)!;
  const idx = (stage: string) => byStage.filter((r) => r.stage === stage).reduce((a, r) => a + r.cost_usd, 0);
  const tok = (stage: string, col: string) => byStage.filter((r) => r.stage === stage).reduce((a, r) => a + (r[col] ?? 0), 0);
  const indexCost = idx("embed") + idx("facts");
  const indexTokens = tok("embed", "input_tokens") + tok("facts", "input_tokens") + tok("facts", "output_tokens");
  const q = one<any>(`SELECT COUNT(*) n, AVG(cost_usd) avg_cost, AVG(latency_ms) avg_latency FROM questions_log WHERE status IN ('answered','no_reliable_answer')`)!;
  const answerCalls = byStage.filter((r) => r.stage === "answer");
  const perQuery = {
    avg_cost_usd: Number((q.avg_cost ?? 0).toFixed(5)),
    avg_input_tokens: answerCalls.length ? Math.round(tok("answer", "input_tokens") / answerCalls.reduce((a, r) => a + r.calls, 0)) : 0,
    avg_output_tokens: answerCalls.length ? Math.round(tok("answer", "output_tokens") / answerCalls.reduce((a, r) => a + r.calls, 0)) : 0,
    avg_embed_query_cost_usd: 0.000001, // one 20-token query embedding ≈ $0.0000004
    questions_measured: q.n,
  };
  // ×50: indexing is linear in documents; per-query cost is NOT — the model always reads
  // the same top-k chunks, only the retrieval work grows (BM25/cosine over 50× more rows,
  // still milliseconds in SQLite). Fact-ledger rows per key grow, capped at 14 in the prompt.
  const x50 = {
    documents: (docs.canonical ?? 0) * 50,
    index_cost_usd: Number((indexCost * 50).toFixed(2)),
    index_tokens: indexTokens * 50,
    per_query_cost_usd: perQuery.avg_cost_usd,
    per_1000_queries_usd: Number((perQuery.avg_cost_usd * 1000).toFixed(2)),
    formula: `index: ${indexCost.toFixed(4)} USD × 50 = ${(indexCost * 50).toFixed(2)} USD; query: unchanged (top-k context is fixed; retrieval is O(chunks) in-process)`,
  };
  const report = {
    corpus: { canonical_documents: docs.canonical, fetched_documents: docs.fetched, chunks: chunks.n, chunk_chars: chunks.chars },
    index: { tokens: indexTokens, cost_usd: Number(indexCost.toFixed(5)), embed_cost_usd: Number(idx("embed").toFixed(5)), facts_cost_usd: Number(idx("facts").toFixed(5)) },
    per_query: perQuery,
    eval_judge_cost_usd: Number(idx("judge").toFixed(5)),
    total_spent_usd: Number(byStage.reduce((a, r) => a + r.cost_usd, 0).toFixed(4)),
    by_stage: byStage,
    extrapolation_x50: x50,
  };
  if (asJson) return report;
  return [
    `Corpus: ${report.corpus.canonical_documents} canonical documents (${report.corpus.fetched_documents} fetched), ${report.corpus.chunks} chunks`,
    `Index build: ${report.index.tokens.toLocaleString()} tokens → $${report.index.cost_usd} (embeddings $${report.index.embed_cost_usd} + fact extraction $${report.index.facts_cost_usd})`,
    `Per query: $${perQuery.avg_cost_usd} avg over ${perQuery.questions_measured} questions (~${perQuery.avg_input_tokens} in / ${perQuery.avg_output_tokens} out tokens)`,
    `Total spent so far: $${report.total_spent_usd}`,
    ``,
    `×50 corpus (${x50.documents} documents): index ≈ $${x50.index_cost_usd}; per query ≈ $${x50.per_query_cost_usd} (≈ $${x50.per_1000_queries_usd} per 1000 questions)`,
    `  ${x50.formula}`,
    ``,
    ...byStage.map((r) => `  ${r.stage.padEnd(7)} ${r.model.padEnd(24)} calls=${String(r.calls).padStart(4)} in=${String(r.input_tokens).padStart(9)} out=${String(r.output_tokens).padStart(7)} cache=${String(r.cache_read_tokens).padStart(7)} $${r.cost_usd} err=${r.errors}`),
  ].join("\n");
}
