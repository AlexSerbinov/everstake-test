import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { refreshVideos } from "./refresh-videos.js";
import type { ModelClient } from "../../contracts.js";
import type { VideoCandidate } from "../youtube/screen-videos.js";
const model: ModelClient = {
  generate: async () => {
    throw new Error("Unexpected model call");
  },
};
const candidate = (id: string): VideoCandidate => ({
  id,
  title: "Everstake interview",
  channelId: "channel",
  url: `https://www.youtube.com/watch?v=${id}`,
  publishedAt: "2026-09-13",
  durationSeconds: 100,
  decision: "accepted",
  reason: "Fixture",
});
test("existing video IDs never download or transcribe; only new IDs enter the bounded pipeline", async () => {
  const db = openDatabase(":memory:");
  const ids: string[] = [];
  try {
    const deps = {
      knownIds: ["old00000001"],
      discover: async () => [
        candidate("old00000001"),
        candidate("new00000001"),
        candidate("new00000002"),
      ],
      metadata: async (c: VideoCandidate) => c,
      process: async (c: VideoCandidate) => {
        ids.push(c.id);
        return null;
      },
    };
    const first = await refreshVideos(db, model, "run", 1, () => {}, deps);
    assert.deepEqual(ids, ["new00000001"]);
    assert.equal(first.skipped, 1);
    assert.equal(first.pending, 1);
    await refreshVideos(db, model, "run", 1, () => {}, deps);
    assert.deepEqual(ids, ["new00000001", "new00000002"]);
    await refreshVideos(db, model, "run", 1, () => {}, deps);
    assert.equal(ids.length, 2);
    assert.equal(first.needsReview, 1);
  } finally {
    db.close();
  }
});
test("failed discovery leaves existing registry untouched; failed processing stays pending for retry", async () => {
  const db = openDatabase(":memory:");
  try {
    const deps = {
      knownIds: [],
      discover: async () => [candidate("new00000001")],
      metadata: async (c: VideoCandidate) => c,
      process: async () => {
        throw new Error("Soniox unavailable");
      },
    };
    await assert.rejects(
      refreshVideos(db, model, "run", 1, () => {}, deps),
      /Soniox unavailable/,
    );
    const rows = db
      .prepare("SELECT * FROM settings WHERE key LIKE 'update_video:%'")
      .all();
    assert.equal(JSON.parse(String(rows[0].value)).status, "pending");
    await assert.rejects(
      refreshVideos(db, model, "run", 1, () => {}, {
        ...deps,
        discover: async () => {
          throw new Error("Discovery unavailable");
        },
      }),
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM settings WHERE key LIKE 'update_video:%'")
        .all(),
      rows,
    );
  } finally {
    db.close();
  }
});
