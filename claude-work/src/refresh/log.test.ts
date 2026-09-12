// The shape of what a refresh leaves behind: the `refresh_runs` / `refresh_changes` log that
// the UI's "what changed" panel and `GET /api/freshness/log` read, and the per-type "last
// refreshed" status derived from the documents themselves.
//
// This is a database test rather than a pure one, against an in-memory copy of the real schema —
// the point being asserted is that the log is *readable*, i.e. that a run's rows come back
// grouped under their run, in order, with the old and new value of a changed fact intact. A
// change log that loses the old value is not a log, it is a notification.
//
// Deliberately no network and no models: `refresh()` itself is exercised for real by the run
// recorded in REPORT.md, while what has to be regression-proof here is the shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run, setDbPath } from "../db.js";

setDbPath(":memory:");
const { refreshLog, freshnessStatus } = await import("./refresh.js");

const RUN = "refresh-test-0001";
const OLDER = "refresh-test-0000";

run(`INSERT INTO stage_runs (run_id, stage, started_at, wall_ms, items, item_unit, bytes_in, ok)
     VALUES (?, 'refresh', '2026-09-12T09:00:00Z', 42000, 120, 'documents', 91000, 1)`, RUN);

const insertRun = (runId: string, startedAt: string, overrides: Record<string, number> = {}) => run(
  `INSERT INTO refresh_runs (run_id, started_at, ended_at, preset, due, checked, conditional_gets, not_modified,
     unchanged, changed, added, removed, reindexed, refacted, facts_changed, bytes_in, cost_usd, ok, dry_run)
   VALUES (?,?,?, 'balanced', ?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
  runId, startedAt, startedAt, overrides.due ?? 120, overrides.checked ?? 120, overrides.conditional_gets ?? 44,
  overrides.not_modified ?? 40, overrides.unchanged ?? 78, overrides.changed ?? 2, overrides.added ?? 1,
  overrides.removed ?? 0, overrides.reindexed ?? 3, overrides.refacted ?? 3, overrides.facts_changed ?? 1,
  overrides.bytes_in ?? 91000, overrides.cost_usd ?? 0.0184, overrides.dry_run ?? 0);

insertRun(OLDER, "2026-09-11T09:00:00Z");
insertRun(RUN, "2026-09-12T09:00:00Z");
// A dry run must never appear in the log the UI shows as history: nothing happened.
insertRun("refresh-test-dry", "2026-09-12T10:00:00Z", { dry_run: 1 });

const change = (runId: string, kind: string, fields: Record<string, unknown> = {}) => run(
  `INSERT INTO refresh_changes (run_id, ts, kind, source_type, doc_id, url, title, detail, fact_key, old_value, new_value)
   VALUES (?, '2026-09-12T09:00:10Z', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  runId, kind, fields.source_type ?? "live_pages", fields.doc_id ?? 1, fields.url ?? "https://everstake.com/company/about",
  fields.title ?? "About", fields.detail ?? "content hash aaaaaaaa → bbbbbbbb",
  fields.fact_key ?? null, fields.old_value ?? null, fields.new_value ?? null);

change(RUN, "changed");
change(RUN, "fact_changed", { fact_key: "ceo", old_value: "David Kinitsky", new_value: "Sergii Vasylchuk", detail: "the value changed" });
change(RUN, "new", { doc_id: 9, url: "https://everstake.com/resources/blog/new-post", title: "New post", source_type: "blog", detail: "new page in the sitemap" });
change(RUN, "index_stale", { doc_id: 5, source_type: "press", detail: "depth is `check`" });
change(OLDER, "changed", { doc_id: 2, detail: "older run" });

test("the log is newest run first, and a dry run is not history", () => {
  const runs = refreshLog(10);
  assert.deepEqual(runs.map((entry) => entry.run_id), [RUN, OLDER]);
});

test("a run carries its tallies and the wall time measured by the stage wrapper", () => {
  const [latest] = refreshLog(1);
  assert.equal(latest.checked, 120);
  assert.equal(latest.not_modified, 40);
  assert.equal(latest.changed, 2);
  assert.equal(latest.facts_changed, 1);
  assert.equal(latest.cost_usd, 0.0184);
  // Joined from stage_runs, so the log and the cost ledger cannot disagree about how long it took.
  assert.equal(latest.wall_ms, 42000);
});

test("changes are grouped under their own run, never mixed with a neighbouring one", () => {
  const [latest, older] = refreshLog(2);
  assert.equal(latest.changes.length, 4);
  assert.equal(older.changes.length, 1);
  assert.equal(older.changes[0].detail, "older run");
});

test("a changed fact keeps both values — that is the whole point of the log", () => {
  const [latest] = refreshLog(1);
  const fact = latest.changes.find((entry) => entry.kind === "fact_changed")!;
  assert.equal(fact.fact_key, "ceo");
  assert.equal(fact.old_value, "David Kinitsky");
  assert.equal(fact.new_value, "Sergii Vasylchuk");
  // The corpus itself cannot answer this: the page has been overwritten with the new value.
  assert.equal(fact.source_type, "live_pages");
});

test("every kind the runner can emit survives the round trip with its source type", () => {
  const [latest] = refreshLog(1);
  assert.deepEqual(
    latest.changes.map((entry) => `${entry.kind}:${entry.source_type}`).sort(),
    ["changed:live_pages", "fact_changed:live_pages", "index_stale:press", "new:blog"]);
});

test("`limit` bounds the runs, not the changes inside them", () => {
  const runs = refreshLog(1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].changes.length, 4);
});

test("per-type status comes from the documents, so a type nobody checked still reports honestly", () => {
  for (const [id, url, category, checkedAt] of [
    [1, "https://everstake.com/company/about", "site", "2026-09-12T09:00:00Z"],
    [2, "https://everstake.com/resources/blog/a", "site", "2026-09-10T09:00:00Z"],
    [3, "https://everstake.com/resources/blog/b", "site", null],
    [4, "https://docs.everstake.com/api.md", "docs", null],
  ] as const) {
    run(`INSERT INTO documents (id, source_id, url, final_url, domain, category, tier, fetched_at, status, checked_at)
         VALUES (?,'s',?,?,'everstake.com',?,1,'2026-09-01T00:00:00Z','ok',?)`, id, url, url, category, checkedAt);
  }

  const status = Object.fromEntries(freshnessStatus().map((row) => [row.type, row]));
  assert.equal(status.live_pages.documents, 1);
  assert.equal(status.live_pages.newest_checked_at, "2026-09-12T09:00:00Z");
  assert.equal(status.blog.documents, 2);
  assert.equal(status.blog.oldest_checked_at, "2026-09-10T09:00:00Z");
  // One blog post and the whole docs set have never been checked, and the panel must say so
  // rather than showing the freshest sibling's timestamp for the type.
  assert.equal(status.blog.never_checked, 1);
  assert.equal(status.docs.never_checked, 1);
  assert.equal(status.docs.newest_checked_at, null);
  assert.equal(status.video.documents, 0);
});
