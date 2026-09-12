// What is pinned here is the accounting contract, not the numbers: a stage run is recorded
// even when the stage throws, the model calls made inside it carry its run id, and nothing
// outside a stage is attributed to one. Every figure in COST.md rests on those three.
import { test } from "node:test";
import assert from "node:assert/strict";
import { all, one, setDbPath } from "./db.js";

setDbPath(":memory:");
const { withStageMetrics, currentRunId, addStageBytes, stageRun, stageRuns } = await import("./metrics.js");
const { logCall } = await import("./llm.js");

test("a completed stage records its own row with time, CPU, memory, items and bytes", async () => {
  const returned = await withStageMetrics("crawl", async (stage) => {
    stage.items(7, "documents");
    stage.meta({ only: "seed-list" });
    addStageBytes(1500);
    addStageBytes(500);
    // Burn a little wall time and CPU so the assertions below are not testing zero.
    const until = Date.now() + 15;
    while (Date.now() < until) Math.sqrt(Math.random());
    return "done";
  }, { flags: { force: true } });

  assert.equal(returned, "done", "the wrapper returns whatever the body returns");
  const row = stageRuns("crawl").at(-1)!;
  assert.equal(row.stage, "crawl");
  assert.equal(row.ok, 1);
  assert.equal(row.items, 7);
  assert.equal(row.item_unit, "documents");
  assert.equal(row.bytes_in, 2000, "bytes are accumulated across calls, not overwritten");
  assert.ok(row.wall_ms! >= 15, `wall time was measured (${row.wall_ms} ms)`);
  assert.ok(row.cpu_user_ms! >= 0 && row.cpu_system_ms! >= 0, "cpu is a delta over the run, never negative");
  assert.ok(row.peak_rss_bytes! > 0, "peak RSS was sampled");
  assert.ok(row.host && row.host.length > 0, "the machine that measured it is on the row");
  assert.deepEqual(JSON.parse(row.meta!), { flags: { force: true }, only: "seed-list" },
    "initial meta and meta added during the run are merged");
});

test("a stage that throws is still recorded, with ok=0 and the error", async () => {
  await assert.rejects(
    withStageMetrics("facts", async () => { throw new Error("provider exploded"); }),
    /provider exploded/);
  const row = stageRuns("facts").at(-1)!;
  assert.equal(row.ok, 0, "a failed stage is a row, not an absence — it still spent time and money");
  assert.match(row.error!, /provider exploded/);
  assert.ok(row.wall_ms != null, "the time it burned before failing is recorded");
});

test("model calls inside a stage carry its run id; calls outside carry none", async () => {
  assert.equal(currentRunId(), null, "there is no ambient stage outside the wrapper");

  const runId = await withStageMetrics("index", async (stage) => {
    logCall({ stage: "embed", provider: "openai", model: "text-embedding-3-small", input: 100, costUsd: 0.002 });
    return stage.runId;
  });

  logCall({ stage: "embed", provider: "openai", model: "text-embedding-3-small", input: 100, costUsd: 0.002 });

  const attributed = all<{ n: number }>("SELECT COUNT(*) n FROM llm_calls WHERE run_id = ?", runId)[0];
  const orphaned = all<{ n: number }>("SELECT COUNT(*) n FROM llm_calls WHERE run_id IS NULL")[0];
  assert.equal(attributed.n, 1);
  assert.equal(orphaned.n, 1, "a call made outside any stage is NOT attributed to the last one");
  assert.ok(stageRun(runId), "the run id on the call resolves to a real stage_runs row");
});

test("concurrent stages do not steal each other's calls", async () => {
  // The reason `withStageMetrics` uses AsyncLocalStorage rather than a module variable: the
  // HTTP server answers several questions at once, and a shared variable would bill one
  // question's model calls to another.
  const [first, second] = await Promise.all([
    withStageMetrics("question", async (stage) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      logCall({ stage: "agent", provider: "gemini", model: "gemini-3.8-flash", input: 10, costUsd: 0.01 });
      return stage.runId;
    }),
    withStageMetrics("question", async (stage) => {
      logCall({ stage: "agent", provider: "gemini", model: "gemini-3.8-flash", input: 20, costUsd: 0.02 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return stage.runId;
    }),
  ]);

  assert.notEqual(first, second);
  assert.equal(one<{ n: number }>("SELECT input_tokens n FROM llm_calls WHERE run_id = ?", first)!.n, 10);
  assert.equal(one<{ n: number }>("SELECT input_tokens n FROM llm_calls WHERE run_id = ?", second)!.n, 20);
});

test("nested stages attribute each call to the innermost stage that made it", async () => {
  // This is what makes the eval row honest: the judge calls belong to the eval run, the answer
  // calls belong to their own question runs, and adding the two would double-count neither.
  let inner = "";
  const outer = await withStageMetrics("eval", async (stage) => {
    inner = await withStageMetrics("question", async (innerStage) => {
      logCall({ stage: "agent", provider: "gemini", model: "gemini-3.8-flash", input: 1, costUsd: 0.1 });
      return innerStage.runId;
    });
    logCall({ stage: "judge", provider: "gemini", model: "gemini-3.5-flash-lite", input: 2, costUsd: 0.001 });
    return stage.runId;
  });

  assert.equal(one<{ stage: string }>("SELECT stage FROM llm_calls WHERE run_id = ?", inner)!.stage, "agent");
  assert.equal(one<{ stage: string }>("SELECT stage FROM llm_calls WHERE run_id = ?", outer)!.stage, "judge");
});
