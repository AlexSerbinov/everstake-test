// Resource accounting for one execution of a pipeline stage.
//
// `llm_calls` already answers "what did the models cost". This module answers the other half
// of assignment §5.6 — "what did the *stage* cost": how long it ran, how much CPU and memory it
// burned, how many documents or chunks or questions it processed, and how many bytes it pulled
// off the network. Every CLI command and every question is wrapped in `withStageMetrics`, so a
// stage cannot be added to the pipeline and quietly stay unmeasured.
//
// Why a wrapper and not a line in each stage: the numbers have to be collected the same way
// everywhere or they are not comparable, and the interesting ones (CPU, peak RSS) are easy to
// get subtly wrong — `process.cpuUsage()` is cumulative, `resourceUsage().maxRSS` is
// process-lifetime rather than per-stage. Both traps are handled once, here.
//
// The join to money: `stage_runs.run_id` is stamped onto every `llm_calls` row written inside
// the wrapper, via the AsyncLocalStorage below. That is what lets COST.md put "$2.14, 9m 41s,
// 445 documents" on one line without either half being an estimate.
//
// Honest limits, stated because the report repeats them:
//  · RSS and CPU are process-wide. For a CLI stage the process is the stage, so they are its
//    figures. For a question answered by the running server they include whatever else the
//    process did in that window — labelled as such wherever they are shown.
//  · Peak RSS is *sampled*, so a spike shorter than the sampling interval can be missed.
//  · Wall time of a crawl is mostly politeness sleep, which is the point of recording CPU
//    next to it.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { all, nowIso, one, run } from "./db.js";

/** The stages COST.md has a row for. Matches `stage_runs.stage`. */
export type StageName =
  | "crawl" | "dedup" | "index" | "facts" | "eval" | "adversarial" | "question" | "pipeline";

/** Microseconds → milliseconds. `process.cpuUsage()` reports µs; every other duration here is ms. */
const MICROSECONDS_PER_MILLISECOND = 1000;

/**
 * How often process RSS is read while a stage runs. 250 ms costs nothing measurable (one
 * `process.memoryUsage.rss()`, a syscall-free read on every platform we run on) and is fine for
 * stages that last seconds to minutes. A shorter interval would only matter for stages too
 * short to be worth a row.
 */
const RSS_SAMPLE_INTERVAL_MS = 250;

/** What one running stage carries with it. Mutable: the stage reports items and bytes as it goes. */
interface StageContext {
  runId: string;
  stage: StageName;
  items: number | null;
  itemUnit: string | null;
  bytesIn: number;
  meta: Record<string, unknown>;
}

/**
 * The current stage, per async call chain.
 *
 * AsyncLocalStorage rather than a module-level variable because the HTTP server answers several
 * questions concurrently: a plain variable would stamp one question's `run_id` onto another
 * question's model calls, which is precisely the mis-attribution the receipt exists to rule out.
 * It is in `node:async_hooks`, so this costs no dependency.
 */
const stageStorage = new AsyncLocalStorage<StageContext>();

/** `run_id` of the stage currently executing, or null outside any stage. Read by `logCall`. */
export function currentRunId(): string | null {
  return stageStorage.getStore()?.runId ?? null;
}

/**
 * Record how many units this stage processed. Called by the stage itself, because only the
 * stage knows whether its unit is documents, chunks or questions. Last call wins, so a stage
 * may report progressively and still end with the final count.
 */
export function reportStageItems(items: number, unit: string) {
  const store = stageStorage.getStore();
  if (!store) return;
  store.items = items;
  store.itemUnit = unit;
}

/**
 * Add downloaded bytes to the current stage. Called from the fetch layer, so the crawl row can
 * say "500 pages, 41 MB" without the crawler threading a counter through every function.
 * A no-op outside a stage, so `fetch` helpers stay usable from tests and one-off scripts.
 */
export function addStageBytes(bytes: number) {
  const store = stageStorage.getStore();
  if (store) store.bytesIn += bytes;
}

/** Attach free-form context to the stage row (flags it ran with, the question asked, …). */
export function setStageMeta(meta: Record<string, unknown>) {
  const store = stageStorage.getStore();
  if (store) Object.assign(store.meta, meta);
}

/**
 * A short, human-readable label for the machine that took the measurement. It goes on every
 * row because the assignment asks which numbers came from a laptop and which from the VPS, and
 * a report that cannot tell them apart is comparing a 12-core M-series against 2 shared vCPUs.
 */
export function machineLabel(): string {
  const cpu = os.cpus()[0]?.model?.replace(/\s+/g, " ").trim() ?? "unknown cpu";
  const gigabytes = Math.round(os.totalmem() / 1024 ** 3);
  // A role rather than `os.hostname()`: the report is committed to a public repo, the reader
  // needs to know "laptop or server", and a personal machine name answers a question nobody
  // asked while leaking one.
  const role = os.platform() === "darwin" ? "dev laptop" : `${os.type()} host`;
  return `${role} · ${os.type()} ${os.arch()} · ${os.cpus().length}× ${cpu} · ${gigabytes} GB RAM`;
}

/** `facts-mfk2j1-9c1d4a77` — sortable-ish, unique, and readable in a `sqlite3` dump. */
function newRunId(stage: StageName): string {
  return `${stage}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/**
 * Run `body` as a measured stage: one `stage_runs` row, and `run_id` on every model call it
 * makes.
 *
 * The row is written in a `finally`, so a stage that throws is still recorded — with `ok=0` and
 * the error. A crawl that died after 300 of 500 pages spent real money and real minutes, and a
 * cost report that only knows about successful runs understates the true bill.
 *
 * @param body receives a context it can use to report what it processed:
 *        `withStageMetrics("facts", async (stage) => { …; stage.items(445, "documents"); })`
 */
export async function withStageMetrics<T>(
  stage: StageName,
  body: (context: {
    runId: string;
    items: (n: number, unit: string) => void;
    meta: (fields: Record<string, unknown>) => void;
  }) => Promise<T> | T,
  initialMeta: Record<string, unknown> = {},
): Promise<T> {
  const context: StageContext = {
    runId: newRunId(stage),
    stage,
    items: null,
    itemUnit: null,
    bytesIn: 0,
    meta: { ...initialMeta },
  };

  const startedAtIso = nowIso();
  const startedAt = Date.now();
  // Cumulative counters: only the difference between the two reads belongs to this stage.
  const cpuAtStart = process.cpuUsage();
  let peakRss = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, RSS_SAMPLE_INTERVAL_MS);
  // The sampler must never be the reason a CLI command refuses to exit.
  sampler.unref?.();

  let failure: unknown = null;
  try {
    return await stageStorage.run(context, () =>
      body({
        runId: context.runId,
        items: (n, unit) => reportStageItems(n, unit),
        meta: (fields) => setStageMeta(fields),
      }));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearInterval(sampler);
    const cpu = process.cpuUsage(cpuAtStart);
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    writeStageRun({
      runId: context.runId,
      stage,
      startedAt: startedAtIso,
      endedAt: nowIso(),
      wallMs: Date.now() - startedAt,
      cpuUserMs: Math.round(cpu.user / MICROSECONDS_PER_MILLISECOND),
      cpuSystemMs: Math.round(cpu.system / MICROSECONDS_PER_MILLISECOND),
      peakRssBytes: peakRss,
      items: context.items,
      itemUnit: context.itemUnit,
      bytesIn: context.bytesIn,
      ok: failure === null,
      error: failure === null ? null : String((failure as any)?.message ?? failure).slice(0, 300),
      meta: context.meta,
    });
  }
}

/** The single INSERT. Separate from the wrapper so the test can assert on the row shape. */
function writeStageRun(row: {
  runId: string; stage: StageName; startedAt: string; endedAt: string;
  wallMs: number; cpuUserMs: number; cpuSystemMs: number; peakRssBytes: number;
  items: number | null; itemUnit: string | null; bytesIn: number;
  ok: boolean; error: string | null; meta: Record<string, unknown>;
}) {
  run(
    `INSERT INTO stage_runs (run_id, stage, started_at, ended_at, wall_ms, cpu_user_ms, cpu_system_ms,
       peak_rss_bytes, items, item_unit, bytes_in, ok, error, host, meta)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.runId, row.stage, row.startedAt, row.endedAt, row.wallMs, row.cpuUserMs, row.cpuSystemMs,
    row.peakRssBytes, row.items, row.itemUnit,
    // 0 bytes for a stage that never touches the network is a fact; NULL would read as unknown.
    row.bytesIn, row.ok ? 1 : 0, row.error, machineLabel(), JSON.stringify(row.meta),
  );
}

// --- reading it back ---------------------------------------------------------------------

export interface StageRunRow {
  id: number;
  run_id: string;
  stage: string;
  started_at: string;
  ended_at: string | null;
  wall_ms: number | null;
  cpu_user_ms: number | null;
  cpu_system_ms: number | null;
  peak_rss_bytes: number | null;
  items: number | null;
  item_unit: string | null;
  bytes_in: number | null;
  ok: number;
  error: string | null;
  host: string | null;
  meta: string | null;
}

/** Every recorded run, oldest first. Small table by construction — a few hundred rows ever. */
export function stageRuns(stage?: string): StageRunRow[] {
  return stage
    ? all<StageRunRow>("SELECT * FROM stage_runs WHERE stage = ? ORDER BY id", stage)
    : all<StageRunRow>("SELECT * FROM stage_runs ORDER BY id");
}

/** The `stage_runs` row for one run id, or undefined if the stage was never wrapped. */
export function stageRun(runId: string): StageRunRow | undefined {
  return one<StageRunRow>("SELECT * FROM stage_runs WHERE run_id = ?", runId);
}
