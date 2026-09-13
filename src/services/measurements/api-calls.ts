import { randomUUID } from 'node:crypto';
import type { Database } from '../../storage/database.js';
import { calculateCost } from './pricing.js';
import type { AttemptFinish, AttemptStart } from './types.js';

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  constructor(readonly scope: 'run' | 'session', readonly capUsd: number) {
    super(`${scope} API budget of $${capUsd.toFixed(2)} is exhausted`);
    this.name = 'BudgetExceededError';
  }
}

export interface BudgetCaps {
  runUsd: number;
  sessionUsd: number;
  sessionStartedAt: string;
}

export function beginApiAttempt(db: Database, input: AttemptStart, caps?: BudgetCaps): string {
  if (!Number.isFinite(input.reservationUsd) || input.reservationUsd < 0) {
    throw new Error('API budget reservation must be a non-negative finite number');
  }
  const id = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (caps) enforceBudget(db, input.runId, input.reservationUsd, caps);
    db.prepare(
      `INSERT INTO api_calls
       (id, run_id, stage, provider, model, started_at, elapsed_ms, input_tokens, output_tokens, cost_usd, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 'pending', ?)`,
    ).run(
      id,
      input.runId,
      input.stage,
      input.provider,
      input.model,
      new Date().toISOString(),
      JSON.stringify({
        ...input.metadata,
        operationId: input.operationId,
        attempt: input.attempt,
        reservationUsd: input.reservationUsd,
      }),
    );
    db.exec('COMMIT');
    return id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function finishApiAttempt(db: Database, id: string, result: AttemptFinish): void {
  const row = db.prepare('SELECT model, metadata FROM api_calls WHERE id = ?').get(id) as {
    model: string; metadata: string;
  } | undefined;
  if (!row) throw new Error(`Unknown API attempt: ${id}`);
  const prior = parseObject(row.metadata);
  const costUsd = result.actualCostUsd !== undefined
    ? validCost(result.actualCostUsd)
    : result.usage && result.price ? calculateCost(result.usage, result.price) : null;
  const safeError = result.error === undefined ? null : sanitizeError(result.error);
  const metadata = {
    ...prior,
    ...result.metadata,
    providerRequestId: result.providerRequestId ?? null,
    usage: result.usage ? {
      cachedInputTokens: result.usage.cachedInputTokens,
      visibleOutputTokens: result.usage.visibleOutputTokens ?? null,
      thinkingTokens: result.usage.thinkingTokens ?? null,
      raw: result.usage.raw,
    } : null,
    price: result.price ?? null,
    error: safeError,
  };
  const changed = db.prepare(
    `UPDATE api_calls SET model = ?, elapsed_ms = ?, input_tokens = ?, output_tokens = ?,
     cost_usd = ?, status = ?, metadata = ? WHERE id = ? AND status = 'pending'`,
  ).run(
    result.actualModel ?? row.model,
    finiteMilliseconds(result.elapsedMs),
    result.usage?.inputTokens ?? null,
    result.usage?.outputTokens ?? null,
    costUsd,
    result.status,
    JSON.stringify(metadata),
    id,
  );
  if (changed.changes !== 1) throw new Error(`API attempt is already finished: ${id}`);
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:AIza[\w-]{20,}|sk-[\w-]{12,}|Bearer\s+[^\s]+)/gi, '[redacted]')
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function enforceBudget(db: Database, runId: string, reservationUsd: number, caps: BudgetCaps): void {
  const run = budgetUse(db, 'run_id = ?', [runId]);
  if (run.unknownUnreserved || run.usedUsd + reservationUsd > caps.runUsd) {
    throw new BudgetExceededError('run', caps.runUsd);
  }
  const session = budgetUse(db, 'started_at >= ?', [caps.sessionStartedAt]);
  if (session.unknownUnreserved || session.usedUsd + reservationUsd > caps.sessionUsd) {
    throw new BudgetExceededError('session', caps.sessionUsd);
  }
}

function budgetUse(db: Database, where: string, values: string[]): { usedUsd: number; unknownUnreserved: boolean } {
  const rows = db.prepare(`SELECT cost_usd, metadata FROM api_calls WHERE ${where}`).all(...values) as Array<{
    cost_usd: number | null;
    metadata: string;
  }>;
  let usedUsd = 0;
  let unknownUnreserved = false;
  for (const row of rows) {
    if (row.cost_usd !== null) {
      usedUsd += row.cost_usd;
      continue;
    }
    const reservation = parseObject(row.metadata).reservationUsd;
    if (typeof reservation === 'number' && Number.isFinite(reservation) && reservation >= 0) usedUsd += reservation;
    else unknownUnreserved = true;
  }
  return { usedUsd, unknownUnreserved };
}

function finiteMilliseconds(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function validCost(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('API cost must be a non-negative finite number or null');
  return value;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
