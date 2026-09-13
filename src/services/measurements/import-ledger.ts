import { z } from "zod";
import type { Database } from "../../storage/database.js";

const ledgerSchema = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      kind: z.literal("mcp-evaluation"),
      started_at: z.string(),
      finished_at: z.string().nullable(),
      status: z.enum(["completed", "failed"]),
      metadata: z.string(),
    }),
  ),
  calls: z.array(
    z.object({
      id: z.string(),
      run_id: z.string(),
      stage: z.literal("mcp-answer"),
      provider: z.string(),
      model: z.string(),
      started_at: z.string(),
      elapsed_ms: z.number(),
      input_tokens: z.number().nullable(),
      output_tokens: z.number().nullable(),
      cost_usd: z.number().nullable(),
      status: z.string(),
      metadata: z.string(),
    }),
  ),
});

/** Publish measured MCP calls once without replacing any live accounting. */
export function importMcpLedger(db: Database, input: unknown) {
  const ledger = ledgerSchema.parse(input);
  const ids = new Set(ledger.runs.map((run) => run.id));
  if (ledger.calls.some((call) => !ids.has(call.run_id)))
    throw new Error("Every imported call must belong to an imported MCP run");
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, rows] of [
      ["runs", ledger.runs],
      ["api_calls", ledger.calls],
    ] as const) {
      for (const row of rows) {
        const existing = db
          .prepare(`SELECT * FROM ${table} WHERE id=?`)
          .get(row.id);
        const entries = Object.entries(row);
        if (existing) {
          if (entries.some(([key, value]) => existing[key] !== value))
            throw new Error(`Conflicting existing measurement: ${row.id}`);
          continue;
        }
        db.prepare(
          `INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
        ).run(...entries.map(([, value]) => value));
        inserted++;
      }
    }
    db.exec("COMMIT");
    return { inserted, runs: ledger.runs.length, calls: ledger.calls.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
