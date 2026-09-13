import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, getSetting } from "../storage/database.js";
import { buildIndex } from "../services/indexer/build-index.js";
import { stagedRefresh } from "./staged-refresh.js";
import type { DocumentSnapshot, SourceConfig } from "../contracts.js";
const source: SourceConfig = {
  id: "fixture",
  url: "https://example.com",
  publisher: "Fixture",
  kind: "website",
  authority: 1,
  reason: "Fixture",
  enabled: true,
};
const doc = (id: string): DocumentSnapshot => ({
  id,
  url: "https://example.com/" + id,
  canonicalUrl: "https://example.com/" + id,
  title: id,
  text: `Historical evidence ${id} with a dated statement and enough context to remain useful.`,
  publisher: "Fixture",
  kind: "website",
  authority: 1,
  contentHash: id,
  fetchedAt: "2026-09-13",
  publishedAt: null,
  updatedAt: null,
  dateEvidence: null,
  duplicateOf: null,
  revision: id,
  metadata: { sourceId: "fixture" },
});
test("partial crawl never activates or spends on embeddings; history and unrelated writes survive a successful stage", async () => {
  mkdirSync("data", { recursive: true });
  const directory = mkdtempSync(resolve("data/update-preservation-"));
  const db = openDatabase(":memory:");
  let embeds = 0;
  const client = {
    embed: async (request: { input: string | string[] }) => {
      embeds++;
      return {
        model: "text-embedding-3-small",
        inputTokens: 1,
        embeddings: (Array.isArray(request.input)
          ? request.input
          : [request.input]
        ).map(() => [1, 0]),
      };
    },
  };
  try {
    buildIndex(db, [doc("old")], { version: "original" });
    await assert.rejects(
      stagedRefresh(db, [source], client, "run", {
        stagingDirectory: directory,
        collect: async (stage) => ({
          crawls: [],
          failures: [{ sourceId: "fixture", reason: "timeout" }],
          retainedSourceIds: [],
          index: buildIndex(stage, [doc("new")]),
        }),
      }),
      /incomplete/,
    );
    assert.equal(embeds, 0);
    assert.equal(getSetting(db, "corpus_version"), "original");
    assert.equal(
      db.prepare("SELECT active FROM documents WHERE id='old'").get()?.active,
      1,
    );
    await stagedRefresh(db, [source], client, "run", {
      stagingDirectory: directory,
      collect: async (stage) => {
        const index = buildIndex(stage, [doc("new")]);
        // Another agent's unrelated history import after staging must not be deleted.
        db.prepare(
          "INSERT INTO documents(id,url,content_hash,active,snapshot) VALUES(?,?,?,0,?)",
        ).run(
          "parallel",
          doc("parallel").url,
          "parallel",
          JSON.stringify(doc("parallel")),
        );
        db.prepare(
          "INSERT INTO answers(run_id,result) VALUES('old-answer','{}')",
        ).run();
        return { crawls: [], failures: [], retainedSourceIds: [], index };
      },
    });
    assert.equal(
      db.prepare("SELECT active FROM documents WHERE id='new'").get()?.active,
      1,
    );
    assert.equal(
      db.prepare("SELECT active FROM documents WHERE id='old'").get()?.active,
      0,
    );
    assert.equal(
      db.prepare("SELECT active FROM documents WHERE id='parallel'").get()
        ?.active,
      0,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM answers").get()?.n, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("activation replaces chunks of an active document instead of retaining stale passages", async () => {
  mkdirSync("data", { recursive: true });
  const directory = mkdtempSync(resolve("data/update-chunks-"));
  const db = openDatabase(":memory:");
  try {
    buildIndex(db, [doc("same")]);
    db.prepare(
      "INSERT INTO chunks(id,document_id,text,ordinal) VALUES('stale','same','Stale passage',99)",
    ).run();
    db.prepare(
      "INSERT INTO chunks_fts(id,text) VALUES('stale','Stale passage')",
    ).run();
    await stagedRefresh(
      db,
      [source],
      {
        embed: async (request) => ({
          model: "text-embedding-3-small",
          inputTokens: 1,
          embeddings: (Array.isArray(request.input)
            ? request.input
            : [request.input]
          ).map(() => [1]),
        }),
      },
      "run",
      {
        stagingDirectory: directory,
        collect: async (stage) => ({
          crawls: [],
          failures: [],
          retainedSourceIds: [],
          index: buildIndex(stage, [doc("same")]),
        }),
      },
    );
    assert.equal(
      db.prepare("SELECT id FROM chunks WHERE id='stale'").get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT id FROM chunks_fts WHERE id='stale'").get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT active FROM documents WHERE id='same'").get()?.active,
      1,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
