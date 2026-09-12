// What this system actually cost to build and what it costs to answer one question, read out
// of the database rather than estimated, plus the ×50 extrapolation the assignment asks for.
//
// PROVENANCE OF EVERY NUMBER HERE — this is the point of the module:
//   `llm_calls`     — one row written by src/llm.ts for every provider call ever made, with
//                     the token counts the provider reported and the cost computed from the
//                     price table. `by_stage`, the index cost and the token totals all come
//                     from this table, so they are measured, not modelled.
//   `questions_log` — one row per question asked through ask()/answerQuestion(), carrying the
//                     end-to-end cost of that question. `per_query.avg_cost_usd` is an average
//                     over this table, which is why it can differ slightly from summing
//                     `llm_calls` by stage: a question is several calls, and some calls
//                     (retries, judge) are attributed elsewhere.
//   one hardcoded estimate — `avg_embed_query_cost_usd`. Marked as such below.
//
// If this file is wrong, the cost section of REPORT.md is wrong; nothing else depends on it.
// The arithmetic is pinned in cost.test.ts against an in-memory database.

import { all, one } from "../db.js";

/**
 * One 20-token query embedding at text-embedding-3-small prices is roughly $0.0000004.
 * Rounded up to $0.000001 and hardcoded rather than measured: query embeddings are not
 * separated by stage in `llm_calls`, and at four ten-thousandths of a cent the difference
 * is far below the rounding of every other figure in the report.
 */
const QUERY_EMBEDDING_COST_USD = 0.000001;

/** The assignment asks what a 50× larger corpus would cost. Only the corpus scales, not the query. */
const CORPUS_SCALE_FACTOR = 50;

/** Questions that reached a verdict. `error` rows are excluded — see `perQueryFigures`. */
const ANSWERED_STATUSES = "'answered','no_reliable_answer'";

interface StageRow {
  stage: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
  errors: number;
}

/**
 * Measured spend and the ×50 extrapolation. `asJson` returns the object the API and the eval
 * runner embed; otherwise the same numbers formatted for `npm run cost`.
 */
export function costReport(asJson = false) {
  const report = buildCostReport();
  if (asJson) return report;
  return renderCostText(report);
}

function buildCostReport() {
  const byStage = all<StageRow>(
    `SELECT stage, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
      SUM(cache_read_tokens) cache_read_tokens, ROUND(SUM(cost_usd),5) cost_usd, ROUND(AVG(latency_ms)) avg_latency_ms, SUM(ok=0) errors
    FROM llm_calls GROUP BY stage, model ORDER BY stage`);

  /** Total spend of one pipeline stage, summed across whichever models served it. */
  const stageCost = (stage: string) =>
    byStage.filter((row) => row.stage === stage).reduce((sum, row) => sum + row.cost_usd, 0);
  /** Total of one token column for one stage. */
  const stageTokens = (stage: string, column: keyof StageRow) =>
    byStage.filter((row) => row.stage === stage)
      .reduce((sum, row) => sum + ((row[column] as number) ?? 0), 0);

  const corpus = corpusFigures();
  // Indexing = embeddings + the Haiku fact-extraction pass. Output tokens count for `facts`
  // because the extractor writes JSON back; `embed` has no output tokens at all.
  const indexCost = stageCost("embed") + stageCost("facts");
  const indexTokens =
    stageTokens("embed", "input_tokens") +
    stageTokens("facts", "input_tokens") +
    stageTokens("facts", "output_tokens");

  const perQuery = perQueryFigures(byStage, stageTokens);
  const extrapolation = extrapolateToLargerCorpus(
    corpus.canonical_documents, indexCost, indexTokens, perQuery.avg_cost_usd);

  return {
    corpus,
    index: {
      tokens: indexTokens,
      cost_usd: Number(indexCost.toFixed(5)),
      embed_cost_usd: Number(stageCost("embed").toFixed(5)),
      facts_cost_usd: Number(stageCost("facts").toFixed(5)),
    },
    per_query: perQuery,
    // The judge is what it cost to MEASURE the system, not to run it. Kept out of both the
    // index cost and the per-query cost so neither can be inflated by evaluation spend.
    eval_judge_cost_usd: Number(stageCost("judge").toFixed(5)),
    total_spent_usd: Number(byStage.reduce((sum, row) => sum + row.cost_usd, 0).toFixed(4)),
    by_stage: byStage,
    extrapolation_x50: extrapolation,
  };
}

/** Corpus size, counting canonical documents apart from everything that was fetched. */
function corpusFigures() {
  const documents = one<{ canonical: number | null; fetched: number | null }>(
    `SELECT SUM(status='ok' AND duplicate_of IS NULL) canonical, SUM(status='ok') fetched FROM documents`);
  const chunks = one<{ n: number; chars: number | null }>(`SELECT COUNT(*) n, SUM(chars) chars FROM chunks`)!;
  return {
    canonical_documents: documents?.canonical ?? null,
    fetched_documents: documents?.fetched ?? null,
    chunks: chunks.n,
    chunk_chars: chunks.chars,
  };
}

/**
 * The cost of answering one question.
 *
 * `avg_cost_usd` comes from `questions_log` and deliberately excludes rows logged with an
 * `error` status: a question the provider never answered has a cost that is either zero or a
 * wasted retry, and averaging those in would misreport what a working question costs in
 * either direction. `questions_measured` is published alongside it so the exclusion is
 * visible and the denominator can be checked.
 *
 * The token averages come from `llm_calls` instead, divided by answer-stage CALLS rather than
 * by questions — the agent may make several answer calls for one question, and this figure is
 * about the size of one prompt, not the size of one question.
 */
function perQueryFigures(
  byStage: StageRow[],
  stageTokens: (stage: string, column: keyof StageRow) => number,
) {
  const questions = one<{ n: number; avg_cost: number | null; avg_latency: number | null }>(
    `SELECT COUNT(*) n, AVG(cost_usd) avg_cost, AVG(latency_ms) avg_latency
     FROM questions_log WHERE status IN (${ANSWERED_STATUSES})`)!;
  const answerCalls = byStage.filter((row) => row.stage === "answer");
  const totalAnswerCalls = answerCalls.reduce((sum, row) => sum + row.calls, 0);
  return {
    avg_cost_usd: Number((questions.avg_cost ?? 0).toFixed(5)),
    avg_input_tokens: answerCalls.length
      ? Math.round(stageTokens("answer", "input_tokens") / totalAnswerCalls) : 0,
    avg_output_tokens: answerCalls.length
      ? Math.round(stageTokens("answer", "output_tokens") / totalAnswerCalls) : 0,
    avg_embed_query_cost_usd: QUERY_EMBEDDING_COST_USD, // estimated, not measured — see the constant
    questions_measured: questions.n,
  };
}

/**
 * What a 50× corpus would cost. The load-bearing claim is what is NOT multiplied.
 *
 * LINEAR, so multiplied by 50: indexing. Every document is embedded once and passed through
 * the fact extractor once, so 50× the documents is 50× the embedding tokens and 50× the bill.
 *
 * NOT linear, so left alone: the per-query cost. The model always reads the same fixed top-k
 * chunks regardless of how many chunks exist, so the prompt does not grow. What grows is the
 * retrieval work (BM25 and cosine over 50× more rows), and that is in-process SQLite —
 * milliseconds, and free. Fact-ledger rows per key also grow, but the prompt caps them at 14.
 *
 * What this therefore does NOT model, and should not be read as claiming: retrieval QUALITY
 * at 50× (more near-duplicates competing for the same top-k), embedding storage, or the
 * re-crawl cost of keeping a 50× corpus fresh. It is a cost extrapolation, not a scaling proof.
 */
function extrapolateToLargerCorpus(
  canonicalDocuments: number | null,
  indexCost: number,
  indexTokens: number,
  perQueryCost: number,
) {
  const scaledIndexCost = indexCost * CORPUS_SCALE_FACTOR;
  return {
    documents: (canonicalDocuments ?? 0) * CORPUS_SCALE_FACTOR,
    index_cost_usd: Number(scaledIndexCost.toFixed(2)),
    index_tokens: indexTokens * CORPUS_SCALE_FACTOR,
    per_query_cost_usd: perQueryCost,
    per_1000_queries_usd: Number((perQueryCost * 1000).toFixed(2)),
    formula: `index: ${indexCost.toFixed(4)} USD × ${CORPUS_SCALE_FACTOR} = ${scaledIndexCost.toFixed(2)} USD; query: unchanged (top-k context is fixed; retrieval is O(chunks) in-process)`,
  };
}

/** The `npm run cost` console view. Same numbers as the JSON, laid out for a terminal. */
function renderCostText(report: ReturnType<typeof buildCostReport>): string {
  const { corpus, index, per_query: perQuery, extrapolation_x50: x50 } = report;
  return [
    `Corpus: ${corpus.canonical_documents} canonical documents (${corpus.fetched_documents} fetched), ${corpus.chunks} chunks`,
    `Index build: ${index.tokens.toLocaleString()} tokens → $${index.cost_usd} (embeddings $${index.embed_cost_usd} + fact extraction $${index.facts_cost_usd})`,
    `Per query: $${perQuery.avg_cost_usd} avg over ${perQuery.questions_measured} questions (~${perQuery.avg_input_tokens} in / ${perQuery.avg_output_tokens} out tokens)`,
    `Total spent so far: $${report.total_spent_usd}`,
    ``,
    `×${CORPUS_SCALE_FACTOR} corpus (${x50.documents} documents): index ≈ $${x50.index_cost_usd}; per query ≈ $${x50.per_query_cost_usd} (≈ $${x50.per_1000_queries_usd} per 1000 questions)`,
    `  ${x50.formula}`,
    ``,
    // Padded so the per-stage lines line up as columns in a terminal.
    ...report.by_stage.map((row) =>
      `  ${row.stage.padEnd(7)} ${row.model.padEnd(24)} calls=${String(row.calls).padStart(4)} in=${String(row.input_tokens).padStart(9)} out=${String(row.output_tokens).padStart(7)} cache=${String(row.cache_read_tokens).padStart(7)} $${row.cost_usd} err=${row.errors}`),
  ].join("\n");
}
