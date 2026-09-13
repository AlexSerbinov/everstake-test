import type { Database } from '../../storage/database.js';
import type { ApiAttemptView, CostOverview, ReceiptDetail } from './types.js';

interface CallRow {
  id: string; run_id: string; stage: string; provider: string; model: string; started_at: string;
  elapsed_ms: number; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null;
  status: string; metadata: string;
}

export function buildReceipt(db: Database, runId: string): ReceiptDetail {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as {
    id: string; started_at: string; finished_at: string | null; status: string;
  } | undefined;
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const runIds = descendantRunIds(db, runId);
  const placeholders = runIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM api_calls WHERE run_id IN (${placeholders}) ORDER BY started_at, id`,
  ).all(...runIds) as unknown as CallRow[];
  const attempts = rows.map(toAttemptView);
  return {
    runId,
    calls: rows.length,
    inputTokens: sumKnown(rows, 'input_tokens'),
    outputTokens: sumKnown(rows, 'output_tokens'),
    knownCostUsd: sumKnown(rows, 'cost_usd'),
    unknownCalls: rows.filter(row => row.cost_usd === null).length,
    elapsedMs: Math.max(0, Date.parse(run.finished_at ?? new Date().toISOString()) - Date.parse(run.started_at)),
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    status: run.status,
    attempts,
  };
}

export function costOverview(db: Database): CostOverview {
  const rows = db.prepare('SELECT * FROM api_calls ORDER BY started_at, id').all() as unknown as CallRow[];
  return {
    calls: rows.length,
    inputTokens: sumKnown(rows, 'input_tokens'),
    outputTokens: sumKnown(rows, 'output_tokens'),
    knownCostUsd: sumKnown(rows, 'cost_usd'),
    unknownCalls: rows.filter(row => row.cost_usd === null).length,
    pendingCalls: rows.filter(row => row.status === 'pending').length,
    byModel: group(rows, row => `${row.provider}\u0000${row.model}`).map(([key, groupRows]) => {
      const [provider, model] = key.split('\u0000');
      return summary(groupRows, { provider, model });
    }),
    byStatus: group(rows, row => row.status).map(([status, groupRows]) => summary(groupRows, { status })),
  };
}

function descendantRunIds(db: Database, rootId: string): string[] {
  const rows = db.prepare('SELECT id, metadata FROM runs').all() as Array<{ id: string; metadata: string }>;
  const selected = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.id)) continue;
      const parent = parseObject(row.metadata).parentRunId;
      if (typeof parent === 'string' && selected.has(parent)) {
        selected.add(row.id);
        changed = true;
      }
    }
  }
  return [...selected];
}

function toAttemptView(row: CallRow): ApiAttemptView {
  const metadata = parseObject(row.metadata);
  const usage = parseObject(metadata.usage);
  return {
    id: row.id,
    runId: row.run_id,
    stage: row.stage,
    provider: row.provider,
    model: row.model,
    attempt: typeof metadata.attempt === 'number' ? metadata.attempt : 1,
    startedAt: row.started_at,
    elapsedMs: row.elapsed_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedInputTokens: numberOrNull(usage.cachedInputTokens),
    thinkingTokens: numberOrNull(usage.thinkingTokens),
    costUsd: row.cost_usd,
    status: row.status,
    providerRequestId: typeof metadata.providerRequestId === 'string' ? metadata.providerRequestId : null,
    error: typeof metadata.error === 'string' ? metadata.error : null,
  };
}

function summary<T extends Record<string, string>>(rows: CallRow[], labels: T): T & {
  calls: number; knownCostUsd: number; unknownCalls: number;
} {
  return {
    ...labels,
    calls: rows.length,
    knownCostUsd: sumKnown(rows, 'cost_usd'),
    unknownCalls: rows.filter(row => row.cost_usd === null).length,
  };
}

function group(rows: CallRow[], key: (row: CallRow) => string): Array<[string, CallRow[]]> {
  const groups = new Map<string, CallRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()];
}

function sumKnown(rows: CallRow[], key: 'input_tokens' | 'output_tokens' | 'cost_usd'): number {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
