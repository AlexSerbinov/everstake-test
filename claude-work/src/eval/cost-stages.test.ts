// The resource half of the cost report: which runs a stage row describes, and what the ×50
// column claims. Kept in its own file — and therefore its own in-memory database — because it
// needs `stage_runs` rows that would change the totals cost.test.ts pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, setDbPath } from "../db.js";

setDbPath(":memory:");
const { costReport, pipelineStages, costHeadline, measuredVsAssumed, renderCostMd } = await import("./cost.js");

// ── resources per stage ────────────────────────────────────────────────────────────────────
// The aggregation rule is the thing worth pinning: a stage that reprocesses the whole corpus
// is priced by its LATEST SUCCESSFUL run, not by the sum of every attempt. The difference is
// not cosmetic — the embedding stage really was run six times around a rate limit, and summing
// would have published five times the true cost of building the index once.

const stageRun = (
  runId: string, stage: string, ok: number, wall: number, items: number | null, unit: string | null,
  bytes: number | Record<string, unknown> = 0, meta: Record<string, unknown> | null = null,
) => {
  // `bytes` doubles as the meta slot so the existing call sites keep working: every one of them
  // passes a number or nothing, and only the partial-run test needs to record flags.
  const bytesIn = typeof bytes === "number" ? bytes : 0;
  const metaJson = typeof bytes === "object" && bytes !== null ? bytes : meta;
  return run(`INSERT INTO stage_runs (run_id, stage, started_at, ended_at, wall_ms, cpu_user_ms, cpu_system_ms, peak_rss_bytes, items, item_unit, bytes_in, ok, host, meta)
       VALUES (?,?,'2026-09-12T10:00:00Z','2026-09-12T10:01:00Z',?,?,?,?,?,?,?,?,'dev laptop',?)`,
    runId, stage, wall, Math.round(wall / 10), 5, 100_000_000 + wall, items, unit, bytesIn, ok,
    metaJson ? JSON.stringify(metaJson) : null);
};

const callInRun = (runId: string, stage: string, model: string, input: number, output: number, cost: number) =>
  run(`INSERT INTO llm_calls (ts, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, ok, run_id)
       VALUES ('2026-09-12T10:00:30Z',?,'p',?,?,?,0,?,100,1,?)`, stage, model, input, output, cost, runId);

// Rows with NO run id: spend from before per-stage measurement existed. Three fact-extraction
// calls and two stray embeddings, which is the case the "ledger tag only" basis has to handle.
const untaggedCall = (stage: string, model: string, input: number, output: number, cost: number) =>
  run(`INSERT INTO llm_calls (ts, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms, ok)
       VALUES ('2026-09-01T10:00:00Z',?,'p',?,?,?,0,?,900,1)`, stage, model, input, output, cost);

untaggedCall("facts", "claude-haiku-4-5", 5000, 500, 0.01);
untaggedCall("facts", "claude-haiku-4-5", 5000, 500, 0.01);
untaggedCall("facts", "claude-haiku-4-5", 5000, 500, 0.01);
untaggedCall("embed", "text-embedding-3-small", 1_000_000, 0, 0.02);
untaggedCall("embed", "text-embedding-3-small", 1_000_000, 0, 0.02);

// A crawl, then three index runs: two failed on a rate limit, the third did the whole job.
stageRun("crawl-1", "crawl", 1, 240_000, 500, "documents", 120_000_000);
stageRun("index-1", "index", 0, 20_000, null, null);
callInRun("index-1", "embed", "text-embedding-3-small", 400_000, 0, 0.008);
stageRun("index-2", "index", 0, 5_000, null, null);
callInRun("index-2", "embed", "text-embedding-3-small", 100_000, 0, 0.002);
stageRun("index-3", "index", 1, 40_000, 2000, "chunks");
callInRun("index-3", "embed", "text-embedding-3-small", 1_000_000, 0, 0.02);
// Two questions, each its own unit of work.
stageRun("q-1", "question", 1, 12_000, 1, "questions");
callInRun("q-1", "agent", "gemini-3.8-flash", 10_000, 500, 0.01);
stageRun("q-2", "question", 1, 8_000, 1, "questions");
callInRun("q-2", "agent", "gemini-3.8-flash", 6_000, 300, 0.006);

const stages = pipelineStages();
const stageById = (id: string) => stages.find((row: any) => row.id === id)!;

test("a whole-corpus stage is priced by its largest complete run, not the sum of its attempts", () => {
  const index = stageById("index");
  assert.equal(index.basis, "largest complete run");
  assert.equal(index.runs, 3, "all three attempts are still recorded");
  assert.equal(index.cost_usd, 0.02, "the two failed attempts are not part of what indexing costs");
  assert.equal(index.all_time_cost_usd, 0.07,
    "…but the money they really spent is still reported: 0.008 + 0.002 failed + 0.02 succeeded, "
    + "plus the 0.04 of untagged embed rows above");
  assert.equal(index.items, 2000);
  assert.equal(index.wall_ms, 40_000, "and the time is one run's, not 65 s of retries");
  assert.equal(index.cost_per_unit_usd, 0.00001, "0.02 / 2000 chunks");
});

test("a per-item stage sums its runs, because each run is a different question", () => {
  const question = stageById("question");
  assert.equal(question.basis, "sum of runs");
  assert.equal(question.items, 2);
  assert.equal(question.cost_usd, 0.016);
  assert.equal(question.wall_ms, 20_000);
  assert.equal(question.cost_per_unit_usd, 0.008, "the figure the headline quotes");
});

test("a stage that never ran under measurement keeps its money and admits it has no resources", () => {
  const facts = stageById("facts");
  assert.equal(facts.basis, "ledger tag only");
  assert.equal(facts.cost_usd, 0.03, "the three untagged fact-extraction rows above");
  assert.equal(facts.unattributed_calls, 3);
  assert.equal(facts.wall_ms, null, "no time is invented for it");
  assert.equal(facts.cpu_ms, null);
  assert.equal(facts.items, null);
  assert.equal(facts.cost_per_unit_usd, null, "and no $/unit is derived from a denominator we do not have");
});

test("a code-only stage records resources and a measured zero cost, not a missing one", () => {
  const crawl = stageById("crawl");
  assert.equal(crawl.cost_usd, 0);
  assert.equal(crawl.items, 500);
  assert.equal(crawl.bytes_in, 120_000_000);
  assert.equal(crawl.wall_ms, 240_000);
  assert.deepEqual(crawl.models, [], "no model was called, so no model is named");
});

test("the ×50 column multiplies what scales and says why the rest does not", () => {
  assert.equal(stageById("index").x50.cost_usd, 1, "0.02 × 50");
  assert.match(stageById("index").x50.formula, /\$0\.0200 × 50 = \$1\.00/);
  assert.equal(stageById("crawl").x50.wall_ms, 240_000 * 50, "free in money, 50× in time");
  assert.match(stageById("crawl").x50.formula, /free at any size/);
  // The question row is the load-bearing "does not scale" claim of the whole report.
  assert.equal(stageById("question").x50.cost_usd, 0.008, "per question, and unchanged");
  assert.match(stageById("question").x50.formula, /unchanged at \$0\.0080 per question/);
});

test("the headline quotes the measured per-question cost, not the all-time cross-model average", () => {
  const headline = costHeadline({ ...(costReport(true) as any), pipeline: stages });
  assert.equal(headline.build_cost_usd, 0.05, "crawl 0 + dedup 0 + index 0.02 + facts 0.03");
  assert.equal(headline.per_question_usd, 0.008, "from the two measured questions");
  assert.equal(headline.all_time_per_question_usd, 0, "no questions_log rows here, so the all-time average is empty");
  assert.match(headline.sentence, /^Building the whole index cost \$0\.0500\. One question costs about \$0\.0080\.$/);
  assert.equal(headline.per_question_basis, "measured over 2 questions on the current model");
  assert.match(headline.where_the_money_goes, /60% of the build cost is fact extraction/);
});

test("the honesty section grows a line for spend that has no measured run behind it", () => {
  const honesty = measuredVsAssumed({ ...(costReport(true) as any), pipeline: stages });
  assert.ok(honesty.assumed.some((line: string) => /logged before per-stage measurement existed/.test(line)));
  assert.ok(honesty.assumed.some((line: string) => /Never yet run under measurement.*Fact extraction/.test(line)));
  assert.ok(honesty.measured.some((line: string) => /provider's own usage fields/.test(line)));
});

test("COST.md renders every section and states the price table it used", () => {
  const markdown = renderCostMd(costReport(true) as any);
  for (const heading of ["## 1. Per stage", "## 2. One real question", "## 3. ×50 corpus, per row",
    "## 4. What is measured, what is assumed", "## 5. Price table used", "## 6. Individual runs"]) {
    assert.ok(markdown.includes(heading), `missing section: ${heading}`);
  }
  assert.match(markdown, /gemini-3\.8-flash` \| 0\.75 \| 3\.75 \| 0\.075/, "the price table is published, not just used");
  assert.match(markdown, /index-3/, "individual runs are listed by id so a figure can be traced to one run");
  assert.ok(!markdown.includes("$0.000000"), "a real cost is never rendered as a rounded-away zero");
});

test("a partial re-run keeps its row but is never published as the price of a build", () => {
  // The case this exists for: repairing twelve emptied documents with `crawl --only=youtube`
  // followed by an incremental `npm run index` left the cost report claiming the index build
  // processed 27 chunks and the crawl 23 pages.
  stageRun("index-4", "index", 1, 900, 27, "chunks", 0, { flags: {} });
  callInRun("index-4", "embed", "text-embedding-3-small", 14_000, 0, 0.00025);
  stageRun("crawl-only", "crawl", 1, 3_700, 23, "documents", 0, { flags: { only: "youtube" } });

  const after = pipelineStages();
  const index = after.find((row: any) => row.id === "index")!;
  assert.equal(index.items, 2000, "the 2000-chunk build still represents the stage");
  assert.equal(index.runs, 4, "…and the small run is still counted as a recorded run");
  const crawl = after.find((row: any) => row.id === "crawl")!;
  assert.notEqual(crawl.items, 23, "an --only run must not become the crawl's headline figure");
});
