import { randomUUID } from "node:crypto";
import type { ModelMessage } from "../contracts.js";
import { readConfig } from "../config.js";
import type { Database } from "../storage/database.js";
import {
  beginApiAttempt,
  finishApiAttempt,
  sanitizeError,
  type BudgetCaps,
} from "../services/measurements/api-calls.js";
import type { NormalizedUsage } from "../services/measurements/types.js";
import {
  apiKey,
  loadModelsConfig,
  priceFor,
  providerBaseUrl,
  type ModelsConfig,
} from "./provider-config.js";

// Session spending starts when this process starts, not on each request.
const PROCESS_SESSION_STARTED_AT = new Date().toISOString();

export interface ClientOptions {
  config?: ModelsConfig;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface AttemptResult<T> {
  value: T;
  model: string;
  usage: NormalizedUsage | null;
  requestId: string | null;
}

export interface AttemptContext {
  signal: AbortSignal;
  key: string;
  baseURL: string;
}

// Carry reported usage through the error path when the response cannot be used.
export class MeteredResponseError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly usage: NormalizedUsage | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "MeteredResponseError";
  }
}

export function createClientContext(options: ClientOptions) {
  const policy = readConfig<{
    maxRunCostUsd: number;
    maxSessionCostUsd: number;
  }>("policy");
  return {
    config: options.config ?? loadModelsConfig(),
    environment: options.environment ?? process.env,
    fetch: options.fetch ?? globalThis.fetch,
    sleep:
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    caps: {
      runUsd: policy.maxRunCostUsd,
      sessionUsd: policy.maxSessionCostUsd,
      sessionStartedAt: PROCESS_SESSION_STARTED_AT,
    } satisfies BudgetCaps,
  };
}

export async function runMeteredAttempts<T, R>(
  db: Database,
  client: ReturnType<typeof createClientContext>,
  options: {
    request: {
      runId: string;
      stage: string;
      system?: string;
      messages?: ModelMessage[];
      input?: string | string[];
      maxOutputTokens?: number;
      signal?: AbortSignal;
    };
    provider: string;
    model: string;
    settings: ModelsConfig["providers"]["gemini"];
    call(context: AttemptContext): Promise<AttemptResult<T>>;
    response(result: AttemptResult<T>): R;
  },
): Promise<R> {
  // Retries belong to one request, but each attempt gets its own cost record.
  const operationId = randomUUID();
  const key = apiKey(options.settings, client.environment);
  const baseURL = providerBaseUrl(
    options.provider as "gemini" | "openai",
    options.settings,
    client.environment,
  );
  let lastError: unknown;
  const callerSignal = options.request.signal;
  for (let attempt = 1; attempt <= options.settings.maxAttempts; attempt += 1) {
    if (callerSignal?.aborted) throw cancelledError();
    // Reserve the budget before sending: a timeout can still cost money.
    const attemptId = beginApiAttempt(
      db,
      {
        runId: options.request.runId,
        stage: options.request.stage,
        provider: options.provider,
        model: options.model,
        attempt,
        operationId,
        reservationUsd: reserveRequestBudget(
          client.config,
          options.model,
          options.request,
        ),
      },
      client.caps,
    );
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.settings.timeoutMs,
    );
    // The same fetch signal handles both the timeout and the caller leaving.
    // Keep the caller signal separate so we can tell those outcomes apart.
    const cancel = () => controller.abort();
    callerSignal?.addEventListener("abort", cancel, { once: true });
    let result: AttemptResult<T> | null = null;
    try {
      result = await options.call({ signal: controller.signal, key, baseURL });
      const price = priceFor(client.config, result.model);
      finishApiAttempt(db, attemptId, {
        status: "completed",
        elapsedMs: performance.now() - startedAt,
        usage: result.usage,
        price,
        providerRequestId: result.requestId,
        actualModel: result.model,
      });
      return options.response(result);
    } catch (error) {
      const safeError = new Error(sanitizeError(error));
      safeError.name = error instanceof Error ? error.name : "Error";
      lastError = safeError;
      const cancelled = callerSignal?.aborted ?? false;
      const timedOut = controller.signal.aborted && !cancelled;
      // A rejected response can still contain billable usage. Keep it.
      // Missing usage stays unknown; it must not become a zero-cost call.
      const metered = error instanceof MeteredResponseError ? error : null;
      finishApiAttempt(db, attemptId, {
        status: cancelled ? "cancelled" : timedOut ? "timed_out" : "error",
        elapsedMs: performance.now() - startedAt,
        usage: result?.usage ?? metered?.usage,
        price:
          result || metered
            ? priceFor(client.config, result?.model ?? metered!.model)
            : null,
        providerRequestId: result?.requestId ?? metered?.requestId,
        actualModel: result?.model ?? metered?.model,
        error: safeError,
      });
      // A timeout may be retried. A user cancellation must stop the request.
      if (cancelled) throw cancelledError();
      if (
        attempt === options.settings.maxAttempts ||
        !shouldRetryAttempt(error, timedOut)
      )
        throw safeError;
      // The next loop checks cancellation again before reserving or sending.
      await client.sleep(Math.min(1_000 * 2 ** (attempt - 1), 8_000));
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    }
  }
  throw lastError;
}

export function cancelledError(): Error {
  const error = new Error("Request cancelled by the user");
  error.name = "AbortError";
  return error;
}

function shouldRetryAttempt(error: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  const match =
    error instanceof Error ? /^HTTP (\d+):/.exec(error.message) : null;
  if (!match) return error instanceof TypeError;
  const status = Number(match[1]);
  return status === 408 || status === 429 || status >= 500;
}

// This is a safety allowance for the budget, not measured or billed usage.
// Use bytes as a conservative input bound and leave room for message framing.
function reserveRequestBudget(
  config: ModelsConfig,
  model: string,
  request: {
    system?: string;
    messages?: ModelMessage[];
    input?: string | string[];
    maxOutputTokens?: number;
  },
): number {
  const price = priceFor(config, model);
  if (!price) return config.unknownCallReserveUsd;
  const bytes =
    Buffer.byteLength(
      JSON.stringify({
        system: request.system,
        messages: request.messages,
        input: request.input,
      }),
      "utf8",
    ) +
    1024 * (1 + (request.messages?.length ?? 0));
  const output =
    request.input !== undefined ? 0 : (request.maxOutputTokens ?? 4096);
  return Math.max(
    config.unknownCallReserveUsd,
    (bytes * price.inputPerMillionUsd + output * price.outputPerMillionUsd) /
      1e6,
  );
}
