import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "./api.js";
import { openDatabase } from "./storage/database.js";
test("invalid input and unauthorized refresh do not invoke expensive operations", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const app = createApi({
    db,
    ask: async () => {
      calls++;
      throw new Error("unexpected");
    },
    costs: () => ({}),
    refresh: async () => {
      calls++;
    },
  });
  const bad = await app.request("/api/ask", { method: "POST", body: "{}" });
  assert.equal(bad.status, 400);
  const refresh = await app.request("/api/refresh", {
    method: "POST",
    body: "{}",
  });
  assert.equal(refresh.status, 401);
  assert.equal(calls, 0);
  db.close();
});

test("oversized declared and streamed bodies are rejected before provider work", async () => {
  const db = openDatabase(":memory:");
  let calls = 0;
  const app = createApi({
    db,
    ask: async () => {
      calls++;
      throw new Error("unexpected");
    },
    costs: () => ({}),
    refresh: async () => {
      calls++;
    },
  });
  for (const headers of [
    new Headers(),
    new Headers({ "content-length": "17000" }),
  ]) {
    const response = await app.request("/api/ask", {
      method: "POST",
      headers,
      body: "x".repeat(17000),
    });
    assert.equal(response.status, 413);
  }
  assert.equal(calls, 0);
  db.close();
});
