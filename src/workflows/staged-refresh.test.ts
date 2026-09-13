import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, setSetting, getSetting } from "../storage/database.js";
import {
  activateStagedCorpus,
  dueSources,
  stagedRefresh,
} from "./staged-refresh.js";
import { buildIndex } from "../services/indexer/build-index.js";
import type { DocumentSnapshot, SourceConfig } from "../contracts.js";
mkdirSync("data", { recursive: true });
const source: SourceConfig = {
  id: "test",
  url: "https://example.com",
  publisher: "Example",
  authority: 1,
  kind: "website",
  reason: "Public fixture",
  enabled: true,
};
const document = (id: string): DocumentSnapshot => ({
  id,
  url: `https://example.com/${id}`,
  canonicalUrl: `https://example.com/${id}`,
  title: id,
  publisher: "Example",
  authority: 1,
  kind: "website",
  text: `Public fixture document ${id} has sufficient words for this index.`,
  contentHash: id,
  fetchedAt: "2026-09-13T12:00:00Z",
  publishedAt: null,
  updatedAt: null,
  dateEvidence: null,
  duplicateOf: null,
  revision: "1",
  metadata: { sourceId: "test" },
});
test("staged activation replaces text and vectors together while retaining run ledger", () => {
  const directory = mkdtempSync(resolve("data/stage-test-"));
  const db = openDatabase(":memory:");
  const stage = openDatabase(directory + "/stage.sqlite");
  try {
    buildIndex(db, [document("old")]);
    buildIndex(stage, [document("new")]);
    db.prepare(
      "INSERT INTO runs(id,kind,started_at,status) VALUES('paid','test','now','completed')",
    ).run();
    stage.close();
    activateStagedCorpus(db, directory + "/stage.sqlite");
    assert.equal(
      db.prepare("SELECT id FROM documents WHERE active=1").get()!.id,
      "new",
    );
    assert.equal(db.prepare("SELECT count(*) n FROM runs").get()!.n, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("failed embeddings leave the serving corpus intact and persist a resumable job", async () => {
  const db = openDatabase(":memory:");
  buildIndex(db, [document("old")]);
  const version = getSetting(db, "corpus_version");
  const collect: NonNullable<
    Parameters<typeof stagedRefresh>[4]
  >["collect"] = async (staged) => ({
    crawls: [],
    failures: [],
    retainedSourceIds: [],
    index: buildIndex(staged, [document("new")]),
  });
  try {
    await assert.rejects(
      stagedRefresh(
        db,
        [source],
        {
          embed: async () => {
            throw new Error("Fixture provider failure");
          },
        },
        "run",
        { collect },
      ),
      /Fixture provider failure/,
    );
    assert.equal(getSetting(db, "corpus_version"), version);
    const row = db
      .prepare("SELECT value FROM settings WHERE key LIKE 'refresh_job:%'")
      .get()!;
    const job = JSON.parse(String(row.value));
    assert.equal(job.status, "failed");
    assert.equal(job.phase, "embedding");
    rmSync(job.stagePath, { force: true });
    rmSync(job.stagePath.replace(".sqlite", ".json"), { force: true });
  } finally {
    db.close();
  }
});
test("source recency determines due work independently of manual forced refresh", () => {
  const db = openDatabase(":memory:");
  setSetting(db, "source_checked:test", "2026-09-13T12:00:00Z");
  assert.equal(
    dueSources(db, [source], Date.parse("2026-09-13T13:00:00Z")).length,
    0,
  );
  assert.equal(
    dueSources(db, [source], Date.parse("2026-09-14T13:00:00Z")).length,
    1,
  );
  db.close();
});
