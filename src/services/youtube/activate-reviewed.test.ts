import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentSnapshot } from "../../contracts.js";
import type { EmbeddingClient } from "../../providers/model-client.js";
import { getSetting, openDatabase } from "../../storage/database.js";
import { buildIndex } from "../indexer/build-index.js";
import { activateReviewedYouTube } from "./activate-reviewed.js";

function document(id: string, sourceId: string, kind: "website" | "youtube"): DocumentSnapshot {
  return {
    id,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    title: id,
    publisher: "Example",
    authority: 1,
    kind,
    text:
      kind === "youtube"
        ? `[0:01] Alice, COO (company participant; testimony at recording): Evidence from ${id}.`
        : `Evidence from ${id}.`,
    contentHash: id,
    fetchedAt: "2026-09-13T00:00:00Z",
    publishedAt: null,
    updatedAt: null,
    dateEvidence: null,
    duplicateOf: null,
    revision: id,
    metadata: {
      sourceId,
      ...(kind === "youtube" ? { reviewStatus: "reviewed" } : {}),
    },
  };
}

const embeddings: EmbeddingClient = {
  async embed(request) {
    const input = Array.isArray(request.input) ? request.input : [request.input];
    return {
      embeddings: input.map((_, index) => [index + 1, 0]),
      model: request.model ?? "text-embedding-3-small",
      inputTokens: input.length,
    };
  },
};

test("activates a complete YouTube snapshot while retaining other sources", async () => {
  const db = openDatabase(":memory:");
  try {
    const web = document("web", "website", "website");
    const oldVideo = document("old-video", "youtube-inventory", "youtube");
    buildIndex(db, [web, oldVideo], { version: "before" });
    const webChunk = db
      .prepare("SELECT id FROM chunks WHERE document_id='web'")
      .get() as { id: string };
    db.prepare("INSERT INTO embeddings(chunk_id,model,vector) VALUES(?,?,?)").run(
      webChunk.id,
      "text-embedding-3-small",
      "[0,1]",
    );
    await activateReviewedYouTube(
      db,
      [document("new-video", "youtube-inventory", "youtube")],
      embeddings,
      "run",
    );
    assert.deepEqual(
      db.prepare("SELECT id,active FROM documents ORDER BY id").all().map((row) => ({ ...row })),
      [
        { id: "new-video", active: 1 },
        { id: "old-video", active: 0 },
        { id: "web", active: 1 },
      ],
    );
    assert.equal(
      (db.prepare("SELECT count(*) AS count FROM embeddings").get() as { count: number }).count,
      2,
    );
    assert.notEqual(getSetting(db, "corpus_version"), "before");
  } finally {
    db.close();
  }
});

test("embedding failure leaves the serving corpus and version unchanged", async () => {
  const db = openDatabase(":memory:");
  try {
    const web = document("web", "website", "website");
    const oldVideo = document("old-video", "youtube-inventory", "youtube");
    buildIndex(db, [web, oldVideo], { version: "before" });
    const failing: EmbeddingClient = {
      async embed() {
        throw new Error("provider unavailable");
      },
    };
    await assert.rejects(
      activateReviewedYouTube(
        db,
        [document("new-video", "youtube-inventory", "youtube")],
        failing,
        "run",
      ),
      /provider unavailable/,
    );
    assert.equal(getSetting(db, "corpus_version"), "before");
    assert.deepEqual(
      db.prepare("SELECT id,active FROM documents ORDER BY id").all().map((row) => ({ ...row })),
      [
        { id: "old-video", active: 1 },
        { id: "web", active: 1 },
      ],
    );
  } finally {
    db.close();
  }
});

test("reuses matching live vectors and includes retained sources in the version", async () => {
  const db = openDatabase(":memory:");
  try {
    const web = document("web", "website", "website");
    const video = document("video", "youtube-inventory", "youtube");
    buildIndex(db, [web, video], { version: "before" });
    const chunk = db
      .prepare("SELECT id FROM chunks WHERE document_id='video'")
      .get() as { id: string };
    db.prepare("INSERT INTO embeddings(chunk_id,model,vector) VALUES(?,?,?)").run(
      chunk.id,
      "text-embedding-3-small",
      "[1,0]",
    );
    let calls = 0;
    const counting: EmbeddingClient = {
      async embed(request) {
        calls += 1;
        return embeddings.embed(request);
      },
    };
    const first = await activateReviewedYouTube(db, [video], counting, "run-1");
    assert.equal(first.embeddings.indexed, 0);
    assert.equal(calls, 0);
    const versionWithWeb = first.index.version;
    db.prepare("UPDATE documents SET active=0 WHERE id='web'").run();
    const second = await activateReviewedYouTube(db, [video], counting, "run-2");
    assert.equal(second.embeddings.indexed, 0);
    assert.equal(calls, 0);
    assert.notEqual(second.index.version, versionWithWeb);
  } finally {
    db.close();
  }
});
