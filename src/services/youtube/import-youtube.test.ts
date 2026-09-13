import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DocumentSnapshot } from "../../contracts.js";
import { openDatabase } from "../../storage/database.js";
import { importYouTube } from "./import-youtube.js";

test("dry-run, apply and repeated import are safe and idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "youtube-import-"));
  const sourcePath = join(directory, "source.sqlite");
  const targetPath = join(directory, "target.sqlite");
  const documentsPath = join(directory, "documents.json");
  const source = openDatabase(sourcePath);
  source
    .prepare(
      "INSERT INTO runs(id,kind,started_at,finished_at,status,metadata) VALUES(?,?,?,?,?,?)",
    )
    .run(
      "run-1",
      "youtube_video",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:00Z",
      "completed",
      "{}",
    );
  source
    .prepare(
      "INSERT INTO api_calls(id,run_id,stage,provider,model,started_at,elapsed_ms,input_tokens,output_tokens,cost_usd,status,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "call-1",
      "run-1",
      "youtube-transcription",
      "soniox",
      "stt-async-v5",
      "2026-01-01T00:00:00Z",
      1_000,
      null,
      null,
      null,
      "completed",
      '{"providerRequestId":"opaque-request"}',
    );
  source
    .prepare("INSERT INTO youtube_jobs(video_id,status,data) VALUES(?,?,?)")
    .run(
      "DFSEQ3OGoL8",
      "completed",
      '{"videoId":"DFSEQ3OGoL8","status":"completed"}',
    );
  source.close();
  openDatabase(targetPath).close();
  writeFileSync(documentsPath, JSON.stringify([document()]));

  const dryRun = importYouTube({
    sourceDatabasePath: sourcePath,
    targetDatabasePath: targetPath,
    documentsPath,
    dryRun: true,
  });
  assert.deepEqual(dryRun.insert, {
    runs: 1,
    apiCalls: 1,
    jobs: 1,
    documents: 1,
  });
  assert.equal(JSON.stringify(dryRun).includes("opaque-request"), false);
  let target = openDatabase(targetPath);
  assert.equal(
    (
      target.prepare("SELECT COUNT(*) count FROM runs").get() as {
        count: number;
      }
    ).count,
    0,
  );
  target.close();

  const applied = importYouTube({
    sourceDatabasePath: sourcePath,
    targetDatabasePath: targetPath,
    documentsPath,
  });
  assert.deepEqual(applied.insert, {
    runs: 1,
    apiCalls: 1,
    jobs: 1,
    documents: 1,
  });
  assert.equal(applied.documentsInsertedInactive, 1);
  const repeated = importYouTube({
    sourceDatabasePath: sourcePath,
    targetDatabasePath: targetPath,
    documentsPath,
  });
  assert.deepEqual(repeated.insert, {
    runs: 0,
    apiCalls: 0,
    jobs: 0,
    documents: 0,
  });
  assert.deepEqual(repeated.unchanged, {
    runs: 1,
    apiCalls: 1,
    jobs: 1,
    documents: 1,
  });
  target = openDatabase(targetPath);
  assert.equal(
    (target.prepare("SELECT active FROM documents").get() as { active: number })
      .active,
    0,
  );
  assert.equal(
    (
      target.prepare("SELECT input_tokens FROM api_calls").get() as {
        input_tokens: number | null;
      }
    ).input_tokens,
    null,
  );
  target.close();
});

test("conflicting rows abort without partial writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "youtube-import-conflict-"));
  const sourcePath = join(directory, "source.sqlite");
  const targetPath = join(directory, "target.sqlite");
  const documentsPath = join(directory, "documents.json");
  const source = openDatabase(sourcePath);
  source
    .prepare(
      "INSERT INTO runs(id,kind,started_at,finished_at,status,metadata) VALUES(?,?,?,?,?,?)",
    )
    .run("same-id", "youtube_video", "2026-01-01", null, "running", "{}");
  source.close();
  const target = openDatabase(targetPath);
  target
    .prepare(
      "INSERT INTO runs(id,kind,started_at,finished_at,status,metadata) VALUES(?,?,?,?,?,?)",
    )
    .run("same-id", "different", "2026-01-01", null, "running", "{}");
  target.close();
  writeFileSync(documentsPath, "[]");
  assert.throws(
    () =>
      importYouTube({
        sourceDatabasePath: sourcePath,
        targetDatabasePath: targetPath,
        documentsPath,
      }),
    /Import conflict in runs for same-id/,
  );
});

function document(): DocumentSnapshot {
  const text = "[0:01] Speaker: Text";
  const contentHash = createHash("sha256").update(text).digest("hex");
  return {
    id: `youtube:DFSEQ3OGoL8:${contentHash.slice(0, 16)}`,
    url: "https://www.youtube.com/watch?v=DFSEQ3OGoL8",
    canonicalUrl: "https://www.youtube.com/watch?v=DFSEQ3OGoL8",
    title: "Interview",
    publisher: "Publisher",
    authority: 3,
    kind: "youtube",
    text,
    contentHash,
    fetchedAt: "2026-01-01T00:00:00Z",
    publishedAt: "2024-01-01",
    updatedAt: null,
    dateEvidence: "publishedAt: youtube upload date; recordedAt: unknown",
    duplicateOf: null,
    revision: "fixture",
    metadata: {
      sourceId: "youtube-inventory",
      videoId: "DFSEQ3OGoL8",
      speakerStatus: "unverified",
      reviewStatus: "reviewed",
      recordedAt: null,
      refreshStatus: "transcribed",
      freshnessNote: "fixture",
    },
  };
}
