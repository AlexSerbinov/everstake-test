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
