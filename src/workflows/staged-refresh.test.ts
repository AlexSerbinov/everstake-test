import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { openDatabase, setSetting, getSetting } from "../storage/database.js";
import {
  activateStagedCorpus,
  claimRefreshLease,
  dueSources,
  inspectCorpusState,
  releaseRefreshLease,
  renewRefreshLease,
  stagedRefresh,
  type RefreshJob,
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

function addFixtureEmbeddings(db: ReturnType<typeof openDatabase>): void {
  db.exec(
    "INSERT INTO embeddings(chunk_id,model,vector) SELECT id,'text-embedding-3-small','[1]' FROM chunks",
  );
}

function activeId(db: ReturnType<typeof openDatabase>): string {
  return String(
    db.prepare("SELECT id FROM documents WHERE active=1").get()?.id ?? "",
  );
}

test("staged activation replaces text and vectors together while retaining run ledger", () => {
  const directory = mkdtempSync(resolve("data/stage-test-"));
  const db = openDatabase(":memory:");
  const stage = openDatabase(directory + "/stage.sqlite");
  const lease = claimRefreshLease(db, "activation-test");
  try {
    buildIndex(db, [document("old")]);
    buildIndex(stage, [document("new")]);
    addFixtureEmbeddings(stage);
    db.prepare(
      "INSERT INTO runs(id,kind,started_at,status) VALUES('paid','test','now','completed')",
    ).run();
    const expected = inspectCorpusState(stage);
    stage.close();
    activateStagedCorpus(db, directory + "/stage.sqlite", lease, expected);
    assert.equal(activeId(db), "new");
    assert.equal(db.prepare("SELECT count(*) n FROM runs").get()!.n, 1);
  } finally {
    releaseRefreshLease(db, lease);
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
    assert.equal(job.target.activeDocuments, 1);
    assert.equal(job.target.activeChunks, 1);
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

test("resume refuses a missing stage without creating or activating it", async () => {
  const db = openDatabase(":memory:");
  buildIndex(db, [document("old")], { version: "live-v1" });
  const id = randomUUID();
  const stagePath = resolve(`data/staging/${id}.sqlite`);
  const job: RefreshJob = {
    id,
    status: "failed",
    phase: "embedding",
    sourceIds: [source.id],
    stagePath,
    baseline: inspectCorpusState(db),
    target: { version: "target-v2", activeDocuments: 1, activeChunks: 1 },
    startedAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
  };
  setSetting(db, `refresh_job:${id}`, JSON.stringify(job));
  let embeddingCalls = 0;
  try {
    await assert.rejects(
      stagedRefresh(
        db,
        [source],
        {
          embed: async () => {
            embeddingCalls += 1;
            return {
              embeddings: [[1]],
              model: "text-embedding-3-small",
              inputTokens: 1,
            };
          },
        },
        "resume-run",
        { resumeJobId: id },
      ),
      /Staged corpus file is missing; resume refused/,
    );
    assert.equal(embeddingCalls, 0);
    assert.equal(activeId(db), "old");
    assert.equal(getSetting(db, "corpus_version"), "live-v1");
    assert.equal(existsSync(stagePath), false);
  } finally {
    db.close();
    rmSync(stagePath, { force: true });
  }
});

test("resume refuses an incomplete stage without activating it", async () => {
  const db = openDatabase(":memory:");
  buildIndex(db, [document("old")], { version: "live-v1" });
  const id = randomUUID();
  const stagePath = resolve(`data/staging/${id}.sqlite`);
  const stage = openDatabase(stagePath);
  stage.close();
  const job: RefreshJob = {
    id,
    status: "failed",
    phase: "embedding",
    sourceIds: [source.id],
    stagePath,
    baseline: inspectCorpusState(db),
    target: { version: "target-v2", activeDocuments: 1, activeChunks: 1 },
    startedAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
  };
  setSetting(db, `refresh_job:${id}`, JSON.stringify(job));
  writeFileSync(
    resolve(`data/staging/${id}.json`),
    JSON.stringify({
      crawls: [],
      failures: [],
      retainedSourceIds: [],
      index: null,
    }),
  );
  let embeddingCalls = 0;
  try {
    await assert.rejects(
      stagedRefresh(
        db,
        [source],
        {
          embed: async () => {
            embeddingCalls += 1;
            return {
              embeddings: [[1]],
              model: "text-embedding-3-small",
              inputTokens: 1,
            };
          },
        },
        "resume-run",
        { resumeJobId: id },
      ),
      /Staged corpus is incomplete or changed/,
    );
    assert.equal(embeddingCalls, 0);
    assert.equal(activeId(db), "old");
    assert.equal(getSetting(db, "corpus_version"), "live-v1");
  } finally {
    db.close();
    rmSync(stagePath, { force: true });
    rmSync(resolve(`data/staging/${id}.json`), { force: true });
  }
});

test("a stale lease cannot overwrite its successor or activate a corpus", () => {
  const directory = mkdtempSync(resolve("data/stage-test-"));
  const db = openDatabase(":memory:");
  const stage = openDatabase(directory + "/stage.sqlite");
  buildIndex(db, [document("old")], { version: "live-v1" });
  buildIndex(stage, [document("new")], { version: "target-v2" });
  addFixtureEmbeddings(stage);
  const expected = inspectCorpusState(stage);
  stage.close();
  const now = Date.now();
  const stale = claimRefreshLease(db, "old-job", now, 1);
  const successor = claimRefreshLease(db, "new-job", now + 2, 60_000);
  try {
    assert.equal(renewRefreshLease(db, stale, now + 3, 60_000), false);
    const current = JSON.parse(getSetting(db, "refresh_lease"));
    assert.equal(current.ownerToken, successor.ownerToken);
    assert.throws(
      () =>
        activateStagedCorpus(
          db,
          directory + "/stage.sqlite",
          stale,
          expected,
          "text-embedding-3-small",
          now + 3,
        ),
      /Refresh lease was lost/,
    );
    assert.equal(activeId(db), "old");
    activateStagedCorpus(
      db,
      directory + "/stage.sqlite",
      successor,
      expected,
      "text-embedding-3-small",
      now + 3,
    );
    assert.equal(activeId(db), "new");
  } finally {
    releaseRefreshLease(db, successor);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
