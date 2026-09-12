// The receipt is the number a reader is most likely to check by hand — it is right there,
// itemised, on screen. So what is pinned here is that the arithmetic survives that check: the
// total is exactly the sum of the rows, the interleaving matches the order things happened,
// and time that is counted twice is not counted twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, setDbPath } from "../db.js";

setDbPath(":memory:");
const { buildReceipt } = await import("./receipt.js");
import type { Step } from "./shared.js";

const RUN = "question-test-0001";

/** One `llm_calls` row, as `logCall` would have written it inside the run above. */
const call = (stage: string, model: string, input: number, output: number, cacheRead: number, cost: number, latency: number, runId: string | null = RUN, ok = 1) =>
  run(`INSERT INTO llm_calls (ts, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, ok, run_id)
       VALUES ('2026-09-12T00:00:00Z',?,'gemini',?,?,?,?,?,?,?,?)`,
    stage, model, input, output, cacheRead, cost, latency, ok, runId);

const step = (n: number, tool: string, summary: string, ms: number): Step =>
  ({ step: n, tool, args: {}, summary, ms });

// A realistic agent run: turn 1 asks for a search, the search embeds the query and returns,
// turn 2 asks the ledger, turn 3 writes the answer.
call("agent", "gemini-3.8-flash", 4000, 60, 0, 0.003, 900);
call("embed", "text-embedding-3-small", 12, 0, 0, 0.0000002, 120);
call("agent", "gemini-3.8-flash", 6200, 80, 2000, 0.0045, 1100);
call("agent", "gemini-3.8-flash", 7000, 400, 4000, 0.0062, 2400);
// A call from a DIFFERENT question, to prove attribution is by run id and not by recency.
call("agent", "gemini-3.8-flash", 99999, 9999, 0, 9.99, 5000, "question-other-0002");

const STEPS = [step(1, "search_corpus", "8 chunks", 260), step(2, "fact_history", "3 rows", 4)];
const receipt = buildReceipt(RUN, STEPS, 5000);

test("only this question's calls are on the receipt", () => {
  assert.equal(receipt.run_id, RUN);
  assert.ok(!receipt.rows.some((row) => row.tokens_in === 99999),
    "another question's call, logged later, must not appear here");
});

test("rows are interleaved in the order the agent actually ran them", () => {
  assert.deepEqual(receipt.rows.map((row) => [row.n, row.kind]), [
    [1, "model"],      // turn 1 — decides to search
    [2, "embedding"],  // the query embedding, made inside the search
    [3, "tool"],       // search_corpus
    [4, "model"],      // turn 2 — decides to read the ledger
    [5, "tool"],       // fact_history
    [6, "model"],      // turn 3 — writes the answer
  ]);
});

test("every step says in words what it was and what ran it", () => {
  assert.match(receipt.rows[0].label, /^Model turn 1 — deciding what to look at next$/);
  assert.match(receipt.rows[5].label, /^Model turn 3 — writing the answer \(4 000 of them already cached\)$/);
  assert.match(receipt.rows[2].label, /^Searching the corpus — BM25 \+ vectors, ranked in-process — 8 chunks$/);
  assert.equal(receipt.rows[2].detail, "code, free", "a code step is labelled free, not left blank");
  assert.equal(receipt.rows[2].usd, 0, "code steps cost a measured zero");
  assert.equal(receipt.rows[5].detail, "gemini-3.8-flash");
});

test("the total is exactly the sum of the rows", () => {
  const sum = (pick: (row: (typeof receipt.rows)[number]) => number) =>
    receipt.rows.reduce((total, row) => total + pick(row), 0);
  assert.equal(receipt.total.tokens_in, sum((row) => row.tokens_in));
  assert.equal(receipt.total.tokens_out, sum((row) => row.tokens_out));
  assert.equal(receipt.total.cache_read, sum((row) => row.cache_read));
  assert.equal(receipt.total.usd, Number(sum((row) => row.usd).toFixed(7)));
  // And the concrete figures, so a refactor that silently drops a row is caught:
  assert.equal(receipt.total.tokens_in, 4000 + 12 + 6200 + 7000);
  assert.equal(receipt.total.tokens_out, 60 + 80 + 400);
  assert.equal(receipt.total.cache_read, 2000 + 4000);
  assert.equal(receipt.total.usd, 0.0137002);
  assert.equal(receipt.total.model_calls, 4, "three turns plus the embedding");
  assert.equal(receipt.total.tool_calls, 2);
});

test("time counted inside another step is not counted again in the total", () => {
  const embedding = receipt.rows.find((row) => row.kind === "embedding")!;
  assert.equal(embedding.nested, true, "the query embedding happens inside the search step");
  // 900 + 260 + 1100 + 4 + 2400 — the embedding's 120 ms is already inside the search's 260.
  assert.equal(receipt.total.accounted_ms, 4664);
  assert.equal(receipt.total.wall_ms, 5000);
  assert.equal(receipt.total.unaccounted_ms, 336, "the remainder is orchestration, not spread over the steps");
});

test("a question with no measured run yields tool steps only, and says so", () => {
  const unmeasured = buildReceipt(null, STEPS, 300);
  assert.equal(unmeasured.run_id, null);
  assert.deepEqual(unmeasured.rows.map((row) => row.kind), ["tool", "tool"]);
  assert.equal(unmeasured.total.usd, 0, "no calls could be attributed, so no money is claimed");
});

test("a failed call is still on the receipt, marked failed", () => {
  const failedRun = "question-test-fail";
  call("agent", "gemini-3.8-flash", 0, 0, 0, 0, 3000, failedRun, 0);
  const withFailure = buildReceipt(failedRun, [], 3200);
  assert.equal(withFailure.rows[0].failed, true);
  assert.equal(withFailure.rows[0].ms, 3000, "a timeout costs latency even when it costs no tokens");
});

test("unaccounted time is never negative, however the provider rounds its latencies", () => {
  const overRun = "question-test-over";
  call("agent", "gemini-3.8-flash", 10, 1, 0, 0.001, 5000, overRun);
  assert.equal(buildReceipt(overRun, [], 4800).total.unaccounted_ms, 0);
});
