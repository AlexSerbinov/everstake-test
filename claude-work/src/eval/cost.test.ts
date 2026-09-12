// The ×50 extrapolation is a claim about how this system scales, so the arithmetic behind it
// is pinned here: what counts as index cost, what counts as per-query cost, and — the load
// bearing decision — that the per-query figure is NOT multiplied by 50.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, setDbPath } from "../db.js";

setDbPath(":memory:");
const { costReport } = await import("./cost.js");

const EMPTY = costReport(true) as any;

const call = (stage: string, model: string, input: number, output: number, cacheRead: number, cost: number, latency: number, ok = 1) =>
  run(`INSERT INTO llm_calls (ts, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, ok)
       VALUES ('2026-09-10T00:00:00Z',?,'p',?,?,?,?,?,?,?)`, stage, model, input, output, cacheRead, cost, latency, ok);

call("embed", "text-embedding-3-small", 1000, 0, 0, 0.02, 100);
call("embed", "text-embedding-3-small", 1000, 0, 0, 0.02, 100);
call("facts", "claude-haiku-4-5", 5000, 500, 4000, 0.01, 900);
call("facts", "claude-haiku-4-5", 5000, 500, 4000, 0.01, 900);
call("facts", "claude-haiku-4-5", 5000, 500, 4000, 0.01, 900);
call("answer", "claude-opus-5", 8000, 400, 0, 0.05, 4000);
call("answer", "claude-opus-5", 6000, 200, 0, 0.03, 3000);
call("judge", "claude-haiku-4-5", 2000, 100, 0, 0.007, 800, 0);

// 4 canonical documents, 1 alias, 1 dropped
for (const [id, status, dup] of [[1, "ok", null], [2, "ok", null], [3, "ok", null], [4, "ok", null], [5, "ok", 1], [6, "dropped", null]] as const) {
  run(`INSERT INTO documents (id, source_id, url, domain, category, tier, fetched_at, status, duplicate_of)
       VALUES (?,'s',?,'d.test','site',1,'2026-09-10T00:00:00Z',?,?)`, id, `https://d.test/${id}`, status, dup);
}
for (const [id, chars] of [[1, 1000], [2, 1200], [3, 800]] as const) run(`INSERT INTO chunks (id, doc_id, idx, text, chars) VALUES (?,1,0,'t',?)`, id, chars);

run(`INSERT INTO questions_log (ts, question, status, mode, cost_usd, latency_ms) VALUES ('2026-09-10T00:00:00Z','q1','answered','factual',0.05,4000)`);
run(`INSERT INTO questions_log (ts, question, status, mode, cost_usd, latency_ms) VALUES ('2026-09-10T00:00:00Z','q2','no_reliable_answer','factual',0.03,3000)`);
run(`INSERT INTO questions_log (ts, question, status, mode, cost_usd, latency_ms) VALUES ('2026-09-10T00:00:00Z','q3','error',NULL,9.99,9000)`);

const R = costReport(true) as any;

test("the corpus line counts canonical documents separately from everything fetched", () => {
  assert.deepEqual(R.corpus, { canonical_documents: 4, fetched_documents: 5, chunks: 3, chunk_chars: 3000 });
});

// indexing is the one-off cost that really does grow with the corpus: embeddings plus the
// Haiku pass over every document, counting the model's output tokens as well as its input
test("index cost is the embed and facts stages only, with facts output tokens included", () => {
  assert.equal(R.index.cost_usd, 0.07, "0.04 embeddings + 0.03 fact extraction");
  assert.equal(R.index.embed_cost_usd, 0.04);
  assert.equal(R.index.facts_cost_usd, 0.03);
  assert.equal(R.index.tokens, 2000 + 15000 + 1500);
  assert.equal(R.eval_judge_cost_usd, 0.007, "the judge is an eval cost, not an index cost");
  assert.equal(R.total_spent_usd, 0.157, "every stage: 0.04 embed + 0.03 facts + 0.08 answer + 0.007 judge");
});

test("per-query figures come from questions_log, ignoring rows logged as errors", () => {
  assert.equal(R.per_query.questions_measured, 2, "the error row is excluded");
  assert.equal(R.per_query.avg_cost_usd, 0.04);
  assert.equal(R.per_query.avg_input_tokens, 7000, "answer-stage input tokens divided by answer-stage calls");
  assert.equal(R.per_query.avg_output_tokens, 300);
  assert.equal(R.per_query.avg_embed_query_cost_usd, 0.000001, "a fixed estimate, not measured");
});

// the whole point of the extrapolation: 50× the corpus multiplies the one-off indexing bill but
// leaves a question's cost alone, because the model still reads a fixed top-k of chunks
test("×50 multiplies the index bill and the token count but deliberately not the query cost", () => {
  assert.equal(R.extrapolation_x50.documents, 200);
  assert.equal(R.extrapolation_x50.index_cost_usd, 3.5);
  assert.equal(R.extrapolation_x50.index_tokens, 18500 * 50);
  assert.equal(R.extrapolation_x50.per_query_cost_usd, R.per_query.avg_cost_usd);
  assert.equal(R.extrapolation_x50.per_1000_queries_usd, 40);
  assert.equal(R.extrapolation_x50.formula,
    "index: 0.0700 USD × 50 = 3.50 USD; query: unchanged (top-k context is fixed; retrieval is O(chunks) in-process)");
});

test("by_stage keeps one row per stage and model with its call count, tokens and errors", () => {
  const embed = R.by_stage.find((r: any) => r.stage === "embed");
  assert.deepEqual([embed.calls, embed.input_tokens, embed.cost_usd, embed.errors], [2, 2000, 0.04, 0]);
  const judge = R.by_stage.find((r: any) => r.stage === "judge");
  assert.equal(judge.errors, 1, "ok=0 is counted as an error");
  assert.equal(R.by_stage.find((r: any) => r.stage === "answer").avg_latency_ms, 3500);
  assert.deepEqual(R.by_stage.map((r: any) => r.stage), ["answer", "embed", "facts", "judge"], "ordered by stage");
});

test("an empty index reports zeroes instead of nulls or NaN", () => {
  assert.deepEqual(EMPTY.corpus, { canonical_documents: null, fetched_documents: null, chunks: 0, chunk_chars: null });
  assert.deepEqual([EMPTY.index.cost_usd, EMPTY.index.tokens, EMPTY.total_spent_usd], [0, 0, 0]);
  assert.deepEqual([EMPTY.per_query.avg_cost_usd, EMPTY.per_query.avg_input_tokens, EMPTY.per_query.questions_measured], [0, 0, 0]);
  assert.equal(EMPTY.extrapolation_x50.documents, 0, "SUM over no rows is null, coerced to 0 before the ×50");
});

test("the printable report ends with the ×50 line and its formula", () => {
  const text = costReport(false) as string;
  assert.match(text, /×50 corpus \(200 documents\): index ≈ \$3\.5; per query ≈ \$0\.04 \(≈ \$40 per 1000 questions\)/);
  assert.match(text, /Corpus: 4 canonical documents \(5 fetched\), 3 chunks/);
  assert.match(text, /Per query: \$0\.04 avg over 2 questions/);
});
