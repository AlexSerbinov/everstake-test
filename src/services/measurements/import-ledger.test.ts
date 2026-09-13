import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { importMcpLedger } from "./import-ledger.js";
const run = {
  id: "mcp-run",
  kind: "mcp-evaluation",
  started_at: "2026-09-13",
  finished_at: "2026-09-13",
  status: "completed",
  metadata: "{}",
};
const call = {
  id: "mcp-call",
  run_id: run.id,
  stage: "mcp-answer",
  provider: "gemini",
  model: "test",
  started_at: run.started_at,
  elapsed_ms: 1,
  input_tokens: 10,
  output_tokens: 2,
  cost_usd: 0.01,
  status: "completed",
  metadata: "{}",
};
test("MCP measurements import once and keep unknown costs null", () => {
  const db = openDatabase(":memory:");
  try {
    const ledger = {
      runs: [run],
      calls: [call, { ...call, id: "unknown", cost_usd: null }],
    };
    assert.equal(importMcpLedger(db, ledger).inserted, 3);
    assert.equal(importMcpLedger(db, ledger).inserted, 0);
    assert.equal(
      db.prepare("SELECT sum(cost_usd) total FROM api_calls").get()!.total,
      0.01,
    );
    assert.equal(
      db.prepare("SELECT cost_usd FROM api_calls WHERE id='unknown'").get()!
        .cost_usd,
      null,
    );
  } finally {
    db.close();
  }
});
test("conflicting published IDs roll back all newly inserted rows", () => {
  const db = openDatabase(":memory:");
  try {
    importMcpLedger(db, { runs: [run], calls: [call] });
    assert.throws(
      () =>
        importMcpLedger(db, {
          runs: [{ ...run, id: "new" }, run],
          calls: [{ ...call, cost_usd: 99 }],
        }),
      /Conflicting/,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM runs").get()!.n, 1);
    assert.equal(
      db.prepare("SELECT cost_usd FROM api_calls").get()!.cost_usd,
      0.01,
    );
    assert.throws(
      () => importMcpLedger(db, { runs: [], calls: [call] }),
      /must belong/,
    );
  } finally {
    db.close();
  }
});
