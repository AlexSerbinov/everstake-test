import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { beginRun, finishRun } from "../measurements/runs.js";
import {
  beginApiAttempt,
  finishApiAttempt,
} from "../measurements/api-calls.js";
import { reconcileSonioxCosts } from "./reconcile-soniox-costs.js";

test("reconciliation imports only matching provider costs once and preserves forecasts", async () => {
  const db = openDatabase(":memory:");
  const run = beginRun(db, "youtube_video", {});
  const id = beginApiAttempt(
    db,
    {
      runId: run,
      stage: "youtube-transcription",
      provider: "soniox",
      model: "stt-async-v5",
      attempt: 1,
      operationId: "ours",
      reservationUsd: 0.1,
      metadata: { operationId: "ours", forecastCostUsd: 0.1 },
    },
    { runUsd: 3, sessionUsd: 3, sessionStartedAt: "1970-01-01T00:00:00Z" },
  );
  finishApiAttempt(db, id, {
    status: "completed",
    elapsedMs: 20,
    actualCostUsd: null,
    metadata: { transcriptionId: "job-1" },
  });
  finishRun(db, run, "completed");
  const log = {
    uuid: "job-1",
    client_reference_id: "ours",
    model: "stt-async-v5",
    cost_usd: "0.053000",
    input_audio_tokens: 100,
    input_text_tokens: 10,
    output_audio_tokens: 0,
    output_text_tokens: 70,
  };
  const fake = async () =>
    Response.json({
      usage_logs: [
        log,
        { ...log, client_reference_id: "another-project", cost_usd: "99.0" },
      ],
      next_page_cursor: null,
    });
  assert.equal(
    (await reconcileSonioxCosts(db, { apiKey: "test", fetch: fake })).costUsd,
    0.053,
  );
  const row = db.prepare("SELECT * FROM api_calls WHERE id=?").get(id)!;
  assert.equal(row.cost_usd, 0.053);
  assert.equal(row.input_tokens, 110);
  assert.equal(JSON.parse(String(row.metadata)).forecastCostUsd, 0.1);
  assert.equal(
    (
      await reconcileSonioxCosts(db, {
        apiKey: "test",
        fetch: async () => {
          throw new Error("must not repeat");
        },
      })
    ).reconciled,
    0,
  );
  db.close();
});

test("a matching reference with the wrong transcription identity cannot change the ledger", async () => {
  const db = openDatabase(":memory:");
  const run = beginRun(db, "youtube_video", {});
  const id = beginApiAttempt(
    db,
    {
      runId: run,
      stage: "youtube-transcription",
      provider: "soniox",
      model: "stt-async-v5",
      attempt: 1,
      operationId: "ours",
      reservationUsd: 0.1,
      metadata: { operationId: "ours" },
    },
    { runUsd: 3, sessionUsd: 3, sessionStartedAt: "1970-01-01T00:00:00Z" },
  );
  finishApiAttempt(db, id, {
    status: "completed",
    elapsedMs: 20,
    actualCostUsd: null,
    metadata: { transcriptionId: "correct-job" },
  });
  const fake = async () =>
    Response.json({
      usage_logs: [
        {
          uuid: "different-job",
          client_reference_id: "ours",
          model: "stt-async-v5",
          cost_usd: "1.000",
          input_audio_tokens: 10,
          input_text_tokens: 0,
          output_audio_tokens: 0,
          output_text_tokens: 10,
        },
      ],
      next_page_cursor: null,
    });
  await assert.rejects(
    reconcileSonioxCosts(db, { apiKey: "test", fetch: fake }),
    /identity does not match/,
  );
  assert.equal(
    db.prepare("SELECT cost_usd FROM api_calls WHERE id=?").get(id)!.cost_usd,
    null,
  );
  db.close();
});
