import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../storage/database.js";
import type { EmbeddingClient } from "../../providers/model-client.js";
import { loadModelsConfig } from "../../providers/provider-config.js";
import { activeVectors, embedCorpus, hybridSearch } from "./hybrid-search.js";

function corpus(model?: string, vector = [1, 0]) {
  const db = openDatabase(":memory:");
  const snapshot = {
    id: "doc",
    url: "https://example.com",
    title: "Facts",
    authority: 1,
    publisher: "Example",
    publishedAt: null,
    updatedAt: null,
    fetchedAt: "2026-09-14",
    duplicateOf: null,
    metadata: {},
  };
  db.prepare(
    "INSERT INTO documents(id,url,content_hash,snapshot) VALUES(?,?,?,?)",
  ).run("doc", snapshot.url, "hash", JSON.stringify(snapshot));
  db.prepare(
    "INSERT INTO chunks(id,document_id,text,ordinal) VALUES(?,?,?,?)",
  ).run("chunk", "doc", "A corpus fact", 0);
  db.prepare("INSERT INTO chunks_fts(id,text) VALUES(?,?)").run(
    "chunk",
    "A corpus fact",
  );
  if (model)
    db.prepare("INSERT INTO embeddings VALUES(?,?,?)").run(
      "chunk",
      model,
      JSON.stringify(vector),
    );
  return db;
}

const noCall: EmbeddingClient = {
  embed: async () => {
    throw new Error("Unexpected paid call");
  },
};

test("lexical fallback makes no provider request, incompatible model requires rebuilding", async () => {
  const empty = corpus();
  const incompatible = corpus("old-model");
  try {
    assert.equal((await hybridSearch(empty, noCall, "run", "fact")).length, 1);
    await assert.rejects(
      hybridSearch(incompatible, noCall, "run", "fact"),
      /rebuild the index/,
    );
  } finally {
    empty.close();
    incompatible.close();
  }
});

test("query and index use configured model and cached vectors refresh after indexing", async () => {
  const db = corpus();
  const model = loadModelsConfig().embedding;
  const stages: string[] = [];
  const client: EmbeddingClient = {
    embed: async (request) => {
      assert.equal(request.model, model);
      stages.push(request.stage);
      return { model, embeddings: [[1, 0]], inputTokens: 2 };
    },
  };
  try {
    assert.equal(activeVectors(db, model).length, 0);
    assert.equal((await embedCorpus(db, client, "run")).indexed, 1);
    assert.equal(activeVectors(db, model).length, 1);
    assert.equal((await hybridSearch(db, client, "run", "fact")).length, 1);
    assert.deepEqual(stages, ["index", "query-embedding"]);
    assert.equal((await embedCorpus(db, noCall, "run")).indexed, 0);
  } finally {
    db.close();
  }
});

test("queries reject wrong provider model and incompatible vector dimensions", async () => {
  const model = loadModelsConfig().embedding;
  const db = corpus(model);
  try {
    for (const response of [
      { model: "wrong-model", embeddings: [[1, 0]], inputTokens: 1 },
      { model, embeddings: [[1, 0, 0]], inputTokens: 1 },
      { model, embeddings: [], inputTokens: 1 },
      { model, embeddings: [[NaN, 0]], inputTokens: 1 },
    ]) {
      await assert.rejects(
        hybridSearch(db, { embed: async () => response }, "run", "fact"),
        /Embedding|embedding/,
      );
    }
  } finally {
    db.close();
  }
});

test("bad index responses do not save vectors", async () => {
  const model = loadModelsConfig().embedding;
  for (const response of [
    { model: "wrong-model", embeddings: [[1, 0]], inputTokens: 1 },
    { model, embeddings: [[Infinity, 0]], inputTokens: 1 },
  ]) {
    const db = corpus();
    try {
      await assert.rejects(
        embedCorpus(db, { embed: async () => response }, "run"),
        /Embedding/,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM embeddings").get()!.n,
        0,
      );
    } finally {
      db.close();
    }
  }
});

test("stored dimension mismatch fails before a query request", async () => {
  const model = loadModelsConfig().embedding;
  const db = corpus(model);
  try {
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?)").run(
      "chunk-2",
      "doc",
      "Another fact",
      1,
    );
    db.prepare("INSERT INTO embeddings VALUES(?,?,?)").run(
      "chunk-2",
      model,
      "[1,0,0]",
    );
    await assert.rejects(
      hybridSearch(db, noCall, "run", "fact"),
      /dimension mismatch/,
    );
  } finally {
    db.close();
  }
});

test("indexing rejects new vectors incompatible with existing model dimensions", async () => {
  const model = loadModelsConfig().embedding;
  const db = corpus(model);
  try {
    db.prepare("INSERT INTO chunks VALUES(?,?,?,?)").run(
      "chunk-2",
      "doc",
      "Another fact",
      1,
    );
    await assert.rejects(
      embedCorpus(
        db,
        {
          embed: async () => ({
            model,
            embeddings: [[1, 0, 0]],
            inputTokens: 1,
          }),
        },
        "run",
      ),
      /dimension mismatch/,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM embeddings").get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});
