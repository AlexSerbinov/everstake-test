import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, getSetting, setSetting } from "./database.js";
test("database isolates state and upserts settings", () => {
  const a = openDatabase(":memory:");
  const b = openDatabase(":memory:");
  setSetting(a, "corpus_version", "v1");
  setSetting(a, "corpus_version", "v2");
  assert.equal(getSetting(a, "corpus_version"), "v2");
  assert.equal(getSetting(b, "corpus_version"), "");
  a.close();
  b.close();
});
