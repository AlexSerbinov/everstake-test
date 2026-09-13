import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocumentSnapshot } from "../../contracts.js";
import { getSetting, openDatabase } from "../../storage/database.js";
import { buildIndex } from "./build-index.js";

function document(id: string, contentHash = id): DocumentSnapshot {
  return {
    id,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    title: id,
    publisher: "Example",
    authority: 1,
    kind: "website",
    text: `# ${id}\n\nA sufficiently detailed paragraph about staking conditions and source evidence for ${id}.`,
    contentHash,
    fetchedAt: "2026-09-13T00:00:00.000Z",
    publishedAt: null,
    updatedAt: null,
    dateEvidence: null,
    duplicateOf: null,
    revision: contentHash,
    metadata: { sourceId: "source" },
  };
}

test("stores snapshots and searchable chunks while retaining prior revisions", () => {
  const db = openDatabase(":memory:");
  buildIndex(db, [document("v1")], { version: "v1" });
  buildIndex(db, [document("v2")], { version: "v2" });
  assert.equal(getSetting(db, "corpus_version"), "v2");
  assert.deepEqual(
    [...db.prepare("SELECT id,active FROM documents ORDER BY id").all()].map(
      (row) => ({ ...row }),
    ),
    [
      { id: "v1", active: 0 },
      { id: "v2", active: 1 },
    ],
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) AS count FROM chunks_fts WHERE chunks_fts MATCH ?",
        )
        .get("staking") as { count: number }
    ).count,
    2,
  );
  db.close();
});

test("rolls back activation when indexing fails", () => {
  const db = openDatabase(":memory:");
  buildIndex(db, [document("good")], { version: "v1" });
  db.exec(
    "CREATE TRIGGER reject_bad BEFORE INSERT ON documents WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT, 'bad document'); END",
  );
  assert.throws(
    () => buildIndex(db, [document("bad")], { version: "v2" }),
    /bad document/,
  );
  assert.equal(getSetting(db, "corpus_version"), "v1");
  assert.deepEqual(
    [...db.prepare("SELECT id FROM documents WHERE active=1").all()].map(
      (row) => ({ ...row }),
    ),
    [{ id: "good" }],
  );
  db.close();
});

test("indexes one representative for duplicate URLs", () => {
  const db = openDatabase(":memory:");
  const first = document("first", "same");
  const second = {
    ...document("second", "same"),
    text: first.text,
    contentHash: first.contentHash,
  };
  const report = buildIndex(db, [first, second], { version: "copies" });
  assert.equal(report.documents, 2);
  assert.equal(report.canonicalDocuments, 1);
  assert.equal(
    (
      db.prepare("SELECT count(*) AS count FROM chunks").get() as {
        count: number;
      }
    ).count,
    1,
  );
  assert.equal(
    (
      db
        .prepare("SELECT count(*) AS count FROM documents WHERE active=1")
        .get() as { count: number }
    ).count,
    2,
  );
  db.close();
});

test("keeps a changed named fact searchable across near-duplicate revisions", () => {
  const db = openDatabase(":memory:");
  const boilerplate = Array.from(
    { length: 120 },
    (_, index) => `context${index}`,
  ).join(" ");
  const first = {
    ...document("first", "alice"),
    text: `${boilerplate} The chief executive is Alice.`,
    contentHash: "alice",
  };
  const second = {
    ...document("second", "bob"),
    text: `${boilerplate} The chief executive is Bob.`,
    contentHash: "bob",
  };
  buildIndex(db, [first, second], { version: "named-fact-change" });
  const bob = db
    .prepare(
      "SELECT count(*) AS count FROM chunks_fts WHERE chunks_fts MATCH ?",
    )
    .get("Bob") as { count: number };
  assert.equal(bob.count, 1);
  db.close();
});

test("corpus version changes when source observation or authority changes", () => {
  const db = openDatabase(":memory:");
  try {
    const snapshot = document("date");
    const before = buildIndex(db, [snapshot]);
    const after = buildIndex(db, [
      { ...snapshot, fetchedAt: "2026-09-14T12:00:00Z" },
    ]);
    assert.notEqual(before.version, after.version);
  } finally {
    db.close();
  }
});
