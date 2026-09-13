import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { browseCorpus } from "./browse-corpus.js";

function collection() {
  const db = openDatabase(":memory:");
  const insert = db.prepare(
    "INSERT INTO documents(id,url,content_hash,active,snapshot) VALUES(?,?,?,?,?)",
  );
  for (let i = 0; i < 205; i++) {
    const id = String(i).padStart(3, "0");
    const snapshot = {
      id,
      url: `https://example.test/${id}`,
      title: `Document ${id}`,
      publisher: "Example",
      kind: i < 150 ? "docs" : "website",
      duplicateOf: i < 5 ? "original" : null,
      text: i === 204 ? "A literal 10%_ limit" : "Saved excerpt",
    };
    insert.run(id, snapshot.url, id, 1, JSON.stringify(snapshot));
  }
  insert.run(
    "inactive",
    "https://example.test/inactive",
    "inactive",
    0,
    JSON.stringify({ title: "Hidden", text: "Hidden" }),
  );
  return db;
}

test("corpus returns 100-document pages with accurate totals, last-page clamping and no repeated rows", () => {
  const db = collection();
  try {
    const first = browseCorpus(db),
      second = browseCorpus(db, { page: "1" }),
      last = browseCorpus(db, { page: "99" });
    assert.equal(first.documents.length, 100);
    assert.equal(first.total, 205);
    assert.equal(first.collectionTotal, 205);
    assert.equal(first.pageCount, 3);
    assert.equal(first.page, 0);
    assert.equal(first.hasNext, true);
    assert.equal(second.documents[0].id, "100");
    assert.equal(last.documents.length, 5);
    assert.equal(last.page, 2);
    assert.equal(last.hasNext, false);
    assert.equal(
      new Set(
        [...first.documents, ...second.documents, ...last.documents].map(
          (d) => d.id,
        ),
      ).size,
      205,
    );
    assert.equal(browseCorpus(db, { page: "NaN" }).page, 0);
    assert.equal(browseCorpus(db, { page: "Infinity" }).page, 0);
  } finally {
    db.close();
  }
});
test("corpus search applies across the whole collection, supports combined filters and treats SQL wildcards literally", () => {
  const db = collection();
  try {
    const found = browseCorpus(db, { q: "10%_" });
    assert.equal(found.total, 1);
    assert.equal(found.documents[0].id, "204");
    assert.equal(
      browseCorpus(db, { q: "Document 204", kind: "docs" }).total,
      0,
    );
    assert.equal(browseCorpus(db, { kind: "docs", copies: "hide" }).total, 145);
    assert.equal(browseCorpus(db, { copies: "only" }).total, 5);
    assert.equal(browseCorpus(db, { q: "' OR 1=1 --" }).total, 0);
    const empty = browseCorpus(db, { q: "not in this collection", page: "5" });
    assert.equal(empty.page, 0);
    assert.equal(empty.hasNext, false);
    assert.equal(empty.pageCount, 0);
    assert.deepEqual(browseCorpus(db).kinds, [
      { kind: "docs", count: 150 },
      { kind: "website", count: 55 },
    ]);
  } finally {
    db.close();
  }
});
test("empty corpus keeps zero counts and readable version", () => {
  const db = openDatabase(":memory:");
  try {
    const data = browseCorpus(db);
    assert.equal(data.total, 0);
    assert.equal(data.duplicateCount, 0);
    assert.equal(data.version, "unbuilt");
    assert.deepEqual(data.documents, []);
  } finally {
    db.close();
  }
});
