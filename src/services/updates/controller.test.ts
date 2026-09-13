import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, setSetting } from "../../storage/database.js";
import { createUpdateController } from "./controller.js";
import { readUpdateSettings, saveUpdateSettings } from "./settings.js";
const sources = () => [
  { id: "site", label: "Site", kind: "website", intervalHours: 24 },
  { id: "youtube", label: "YouTube", kind: "youtube", intervalHours: 168 },
];
test("settings survive controller recreation and reject unknown sources and invalid intervals", () => {
  const db = openDatabase(":memory:");
  try {
    const settings = readUpdateSettings(db, sources());
    settings.automatic = true;
    settings.sources.site.intervalHours = 12;
    saveUpdateSettings(db, settings, sources());
    assert.equal(
      readUpdateSettings(db, sources()).sources.site.intervalHours,
      12,
    );
    assert.throws(() =>
      saveUpdateSettings(
        db,
        { ...settings, sources: { evil: settings.sources.site } },
        sources(),
      ),
    );
    settings.sources.site.intervalHours = 0;
    assert.throws(() => saveUpdateSettings(db, settings, sources()));
  } finally {
    db.close();
  }
});
test("double click deduplicates and two workers cannot execute the same queue concurrently", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const execute = async () => {
    calls++;
    await wait;
    return { added: 1 };
  };
  const a = createUpdateController(db, execute, { sources });
  const b = createUpdateController(db, execute, { sources });
  try {
    const one = a.enqueue({ sourceId: "site" });
    const two = b.enqueue({ sourceId: "site" });
    assert.equal(one[0].id, two[0].id);
    const running = a.tick();
    await b.tick();
    assert.equal(calls, 1);
    release();
    await running;
    assert.equal(a.status().jobs[0].status, "completed");
  } finally {
    db.close();
  }
});
test("scheduler respects enablement, frequency, priority, failed-run backoff and manual override", async () => {
  const db = openDatabase(":memory:");
  let now = Date.parse("2026-09-13T00:00:00Z");
  const called: string[] = [];
  const control = createUpdateController(
    db,
    async (id) => {
      called.push(id);
      throw new Error("Fixture failure");
    },
    { sources, now: () => now },
  );
  try {
    await control.tick();
    assert.equal(called.length, 0);
    const settings = readUpdateSettings(db, sources());
    settings.automatic = true;
    settings.sources.youtube.priority = 10;
    control.configure(settings);
    await control.tick();
    assert.deepEqual(called, ["youtube"]);
    await control.tick();
    assert.deepEqual(called, ["youtube", "site"]);
    await control.tick();
    assert.equal(called.length, 2);
    control.enqueue({ sourceId: "site" });
    await control.tick();
    assert.equal(called.length, 3);
    now += 24 * 3600_000;
    await control.tick();
    assert.equal(called.length, 4);
    settings.sources.site.enabled = false;
    control.configure(settings);
    assert.throws(() => control.enqueue({ sourceId: "site" }), /disabled/);
  } finally {
    db.close();
  }
});
test("queued manual work survives restart, expired running work becomes interrupted and readers defer activation", async () => {
  const db = openDatabase(":memory:");
  let available = false;
  let calls = 0;
  const make = () =>
    createUpdateController(
      db,
      async () => {
        calls++;
      },
      { sources, available: () => available },
    );
  try {
    const a = make();
    const job = a.enqueue({ sourceId: "site" })[0];
    const b = make();
    await b.tick();
    assert.equal(calls, 0);
    available = true;
    await b.tick();
    assert.equal(calls, 1);
    setSetting(
      db,
      `update_job:${job.id}`,
      JSON.stringify({ ...job, status: "running" }),
    );
    setSetting(
      db,
      "update_worker",
      JSON.stringify({ token: "expired", expires: 1 }),
    );
    assert.equal(make().status().jobs[0].status, "interrupted");
    assert.equal(make().enqueue({ sourceId: "site" }).length, 1);
  } finally {
    db.close();
  }
});
test("pausing automatic updates defers scheduled work but a manual click promotes that queued source", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const control = createUpdateController(
    db,
    async () => {
      calls++;
    },
    { sources },
  );
  try {
    const scheduled = control.enqueue({ sourceId: "site" }, "schedule")[0];
    await control.tick();
    assert.equal(calls, 0);
    const manual = control.enqueue({ sourceId: "site" })[0];
    assert.equal(manual.id, scheduled.id);
    assert.equal(manual.trigger, "manual");
    await control.tick();
    assert.equal(calls, 1);
    const before = db.prepare("SELECT total_changes() n").get()?.n;
    await control.tick();
    assert.equal(db.prepare("SELECT total_changes() n").get()?.n, before);
  } finally {
    db.close();
  }
});

test("batch persists across reload and repeated full-pass requests do not rerun finished sources", async () => {
  const db = openDatabase(":memory:");
  const called: string[] = [];
  const make = () =>
    createUpdateController(
      db,
      async (id, _settings, progress) => {
        progress("Checking sources");
        called.push(id);
        return { added: 2, measuredUsd: 0 };
      },
      { sources },
    );
  try {
    const control = make();
    const batch = control.startBatch();
    assert.equal(batch.jobIds.length, 2);
    await control.tick();
    const reloaded = make();
    assert.deepEqual(reloaded.status().latestBatch, batch);
    assert.deepEqual(reloaded.startBatch(), batch);
    assert.equal(reloaded.status().jobs.length, 2);
    assert.equal(
      reloaded.status().batchJobs.filter((job) => job.status === "completed")
        .length,
      1,
    );
    await reloaded.tick();
    assert.equal(called.length, 2);
    assert.equal(
      reloaded.status().batchJobs.filter((job) => job.status === "completed")
        .length,
      2,
    );
    assert.notEqual(reloaded.startBatch().id, batch.id);
  } finally {
    db.close();
  }
});

test("partial failure stays visible and source retry preserves the active batch", async () => {
  const db = openDatabase(":memory:");
  let fail = true;
  const control = createUpdateController(
    db,
    async (id) => {
      if (id === "site" && fail) throw new Error("Source unavailable");
      return { added: 1 };
    },
    { sources },
  );
  try {
    const batch = control.startBatch();
    await control.tick();
    assert.equal(
      control.status().batchJobs.filter((job) => job.status === "failed")
        .length,
      1,
    );
    assert.equal(
      control.status().batchJobs.filter((job) => job.status === "queued")
        .length,
      1,
    );
    fail = false;
    const retry = control.startBatch({ sourceId: "site" });
    assert.equal(retry.id, batch.id);
    assert.equal(retry.jobIds.length, 2);
    assert.equal(
      control.status().jobs.filter((job) => job.status === "failed").length,
      1,
    );
    await control.tick();
    await control.tick();
    assert.equal(
      control.status().batchJobs.filter((job) => job.status === "completed")
        .length,
      2,
    );
  } finally {
    db.close();
  }
});

test("full-pass batch reuses scheduled source jobs and no enabled sources yields an empty pass", () => {
  const db = openDatabase(":memory:");
  const control = createUpdateController(db, async () => ({}), { sources });
  try {
    const job = control.enqueue({ sourceId: "site" }, "schedule")[0];
    assert.ok(control.startBatch().jobIds.includes(job.id));
    assert.equal(
      control.status().batchJobs.find((entry) => entry.id === job.id)?.trigger,
      "manual",
    );
    const settings = readUpdateSettings(db, sources());
    for (const source of Object.values(settings.sources))
      source.enabled = false;
    control.configure(settings);
    assert.throws(() => control.startBatch({ sourceId: "site" }), /disabled/);
  } finally {
    db.close();
  }
  const emptyDb = openDatabase(":memory:");
  try {
    const empty = createUpdateController(emptyDb, async () => ({}), {
      sources,
    });
    const settings = readUpdateSettings(emptyDb, sources());
    for (const source of Object.values(settings.sources))
      source.enabled = false;
    empty.configure(settings);
    assert.deepEqual(empty.startBatch().jobIds, []);
  } finally {
    emptyDb.close();
  }
});

test("full pass extends an active source-only batch instead of silently omitting enabled sources", async () => {
  const db = openDatabase(":memory:");
  const called: string[] = [];
  const control = createUpdateController(
    db,
    async (id) => {
      called.push(id);
    },
    { sources },
  );
  try {
    const partial = control.startBatch({ sourceId: "site" });
    assert.equal(partial.jobIds.length, 1);
    const full = control.startBatch();
    assert.equal(full.id, partial.id);
    assert.equal(full.jobIds.length, 2);
    assert.ok(full.jobIds.includes(partial.jobIds[0]));
    assert.deepEqual(
      new Set(control.status().batchJobs.map((job) => job.sourceId)),
      new Set(["site", "youtube"]),
    );
    await control.tick();
    const repeated = control.startBatch();
    assert.deepEqual(repeated, full);
    assert.equal(control.status().jobs.length, 2);
    await control.tick();
    assert.deepEqual(called, ["site", "youtube"]);
  } finally {
    db.close();
  }
});

test("full pass adds not-due sources to an active due-only batch without repeating completed members", async () => {
  const db = openDatabase(":memory:");
  const now = Date.parse("2026-09-13T12:00:00Z");
  const extraSources = () => [
    ...sources(),
    { id: "third", label: "Third", kind: "website", intervalHours: 24 },
  ];
  const control = createUpdateController(db, async () => ({}), {
    sources: extraSources,
    now: () => now,
  });
  try {
    setSetting(db, "source_checked:youtube", new Date(now).toISOString());
    const partial = control.startBatch({ due: true });
    assert.equal(partial.jobIds.length, 2);
    await control.tick();
    const full = control.startBatch();
    assert.equal(full.id, partial.id);
    assert.equal(full.jobIds.length, 3);
    assert.equal(control.status().jobs.length, 3);
    assert.equal(
      control.status().batchJobs.filter((job) => job.status === "completed")
        .length,
      1,
    );
    assert.ok(
      control
        .status()
        .batchJobs.some(
          (job) => job.sourceId === "youtube" && job.status === "queued",
        ),
    );
    assert.deepEqual(control.startBatch(), full);
    assert.equal(control.status().jobs.length, 3);
  } finally {
    db.close();
  }
});
