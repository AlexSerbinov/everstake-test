import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../../api.js";
import { openDatabase } from "../../storage/database.js";
import { createUpdateController } from "./controller.js";

test("update routes require authorization for writes, persist settings and enqueue without paid work", async () => {
  const db = openDatabase(":memory:");
  const priorToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "fixture-operator";
  let calls = 0;
  const updates = createUpdateController(
    db,
    async () => {
      calls++;
    },
    {
      sources: () => [
        { id: "site", label: "Site", kind: "website", intervalHours: 24 },
      ],
    },
  );
  const api = createApi({
    db,
    updates,
    ask: async () => {
      throw new Error("Unexpected question");
    },
    costs: () => ({}),
    refresh: async () => {},
  });
  const request = (
    path: string,
    method: string,
    body: unknown,
    authorized = true,
  ) =>
    api.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { Authorization: "Bearer fixture-operator" } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await api.request("/api/updates")).status, 200);
    assert.equal(
      (await request("/api/updates/run", "POST", {}, false)).status,
      401,
    );
    const settings = updates.status().settings;
    assert.equal(
      (await request("/api/updates/settings", "PUT", settings, false)).status,
      401,
    );
    settings.sources.site.intervalHours = 6;
    assert.equal(
      (await request("/api/updates/settings", "PUT", settings)).status,
      200,
    );
    assert.equal(updates.status().settings.sources.site.intervalHours, 6);
    assert.equal(
      (
        await request("/api/updates/settings", "PUT", {
          ...settings,
          automatic: "true",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/updates/run", "POST", { sourceId: "unknown" }))
        .status,
      400,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await request("/api/updates/run", "POST", { sourceId: "site" }))
          .status,
        202,
      );
    assert.equal(updates.status().jobs.length, 1);
    assert.equal(calls, 0);
    await updates.tick();
    assert.equal(calls, 1);
  } finally {
    db.close();
    if (priorToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = priorToken;
  }
});
