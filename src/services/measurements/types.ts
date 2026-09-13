import type { Receipt } from "../../contracts.js";

export type RunStatus =
  "running" | "completed" | "failed" | "cancelled" | "incomplete";
export type AttemptStatus = "pending" | "completed" | "error" | "timed_out";

export interface PriceEntry {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  outputPerMillionUsd: number;
  source: string;
  note?: string;
}

export interface PriceSnapshot extends PriceEntry {
  model: string;
  pricesAsOf: string;
}

export interface NormalizedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  visibleOutputTokens?: number;
  thinkingTokens?: number;
  raw: unknown;
}

export interface AttemptStart {
  runId: string;
  stage: string;
  provider: string;
  model: string;
  attempt: number;
  operationId: string;
  reservationUsd: number;
  metadata?: Record<string, unknown>;
}

export interface AttemptFinish {
  status: Exclude<AttemptStatus, "pending">;
  elapsedMs: number;
  usage?: NormalizedUsage | null;
  price?: PriceSnapshot | null;
  /** Provider-reported or unit-priced charge for non-token services such as STT. */
  actualCostUsd?: number | null;
  providerRequestId?: string | null;
  actualModel?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ReceiptDetail extends Receipt {
  startedAt: string;
  finishedAt: string | null;
  status: string;
  attempts: ApiAttemptView[];
}

export interface ApiAttemptView {
  id: string;
  runId: string;
  stage: string;
  provider: string;
  model: string;
  attempt: number;
  startedAt: string;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  thinkingTokens: number | null;
  costUsd: number | null;
  status: string;
  providerRequestId: string | null;
  error: string | null;
}

export interface CostOverview {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  knownCostUsd: number;
  unknownCalls: number;
  pendingCalls: number;
  byModel: Array<{
    provider: string;
    model: string;
    calls: number;
    knownCostUsd: number;
    unknownCalls: number;
  }>;
  byStatus: Array<{
    status: string;
    calls: number;
    knownCostUsd: number;
    unknownCalls: number;
  }>;
}
