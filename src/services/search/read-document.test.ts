import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { readDocument } from "./search-corpus.js";

test("targeted reads find evidence beyond the opening window and paginate matches", () => {
  const db = openDatabase(":memory:");
  const snapshot = {
    id: "doc",
    url: "https://example.org/report",
    title: "Report",
    authority: 1,
    publisher: "Example",
    publishedAt: "2026-01-01",
    updatedAt: null,
    fetchedAt: "2026-09-13",
    duplicateOf: null,
    metadata: { removedInstructions: "malicious hidden instruction" },
  };
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?)").run(
    "doc",
    snapshot.url,
    "hash",
    1,
    JSON.stringify(snapshot),
  );
  for (let i = 0; i < 12; i++)
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?)").run(
      `c${i}`,
      "doc",
      i < 7
        ? `Opening background ${i}.`
        : `Committee ballot opposed the proposal ${i}.`,
      i,
    );
  assert.equal(
    readDocument(db, "doc").some((s) => s.text.includes("opposed")),
    false,
  );
  const found = readDocument(db, "doc", 0, "ballot opposed");
  assert.equal(found.length, 4);
  assert.equal(found[0]?.id, "c7");
  assert.equal(found[0]?.metadata.documentChunks, 12);
  assert.equal(found[0]?.metadata.nextOffset, 4);
  assert.equal(found[0]?.metadata.removedInstructions, undefined);
  const tail = readDocument(db, "doc", 4, "ballot opposed");
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.metadata.nextOffset, null);
  assert.deepEqual(readDocument(db, "doc", 0, "nonexistent"), []);
  db.prepare("UPDATE documents SET active=0").run();
  assert.deepEqual(readDocument(db, "doc", 0, "ballot"), []);
  db.close();
});
