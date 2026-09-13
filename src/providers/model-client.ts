import { randomUUID } from "node:crypto";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelMessage,
} from "../contracts.js";
import { readConfig } from "../config.js";
import type { Database } from "../storage/database.js";
import {
  beginApiAttempt,
  finishApiAttempt,
  sanitizeError,
  type BudgetCaps,
} from "../services/measurements/api-calls.js";
import { normalizeOpenAiEmbeddingUsage } from "../services/measurements/pricing.js";
import type { NormalizedUsage } from "../services/measurements/types.js";
import { nativeGeminiRequest, parseNativeGemini } from "./gemini.js";
import {
  openAiGenerationRequest,
  parseOpenAiEmbeddings,
  parseOpenAiGeneration,
  providerError,
} from "./openai.js";
import {
  apiKey,
  geminiProtocol,
  loadModelsConfig,
  priceFor,
  providerBaseUrl,
  type ModelsConfig,
} from "./provider-config.js";

const PROCESS_SESSION_STARTED_AT = new Date().toISOString();

export interface EmbeddingRequest {
  runId: string;
  stage: string;
  input: string | string[];
  model?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  inputTokens: number | null;
}

export interface EmbeddingClient {
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

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

interface AttemptContext {
  signal: AbortSignal;
  key: string;
  baseURL: string;
}

class MeteredResponseError extends Error {
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

export function createModelClient(
  db: Database,
  options: ClientOptions = {},
): ModelClient {
  const common = clientContext(options);
  const settings = common.config.providers.gemini;
  const baseURL = providerBaseUrl("gemini", settings, common.environment);
  const protocol = geminiProtocol(settings, baseURL, common.environment);
  return {
    generate: (request) =>
      runMeteredAttempts(db, common, {
        request,
        provider: "gemini",
        model: request.model ?? common.config.answer,
        settings,
        call: async (context) => {
          const model = request.model ?? common.config.answer;
          if (protocol === "native") {
            const response = await common.fetch(
              `${context.baseURL}/models/${encodeURIComponent(model)}:generateContent`,
              {
                method: "POST",
                signal: context.signal,
                headers: {
                  "content-type": "application/json",
                  "x-goog-api-key": context.key,
                },
                body: JSON.stringify(nativeGeminiRequest(request, model)),
              },
            );
            const body = await responseBody(response);
            const parsed = parseNativeGemini(body, model);
            if (!response.ok) {
              throw new MeteredResponseError(
                providerError(body, response.status).message,
                parsed.model,
                parsed.usage,
                parsed.providerRequestId ??
                  response.headers.get("x-request-id"),
              );
            }
            if (!parsed.text) {
              throw new MeteredResponseError(
                "Gemini returned no text",
                parsed.model,
                parsed.usage,
                parsed.providerRequestId ??
                  response.headers.get("x-request-id"),
              );
            }
            return {
              value: parsed,
              model: parsed.model,
              usage: parsed.usage,
              requestId:
                parsed.providerRequestId ??
                response.headers.get("x-request-id"),
            };
          }
          const response = await common.fetch(
            `${context.baseURL}/chat/completions`,
            {
              method: "POST",
              signal: context.signal,
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${context.key}`,
              },
              body: JSON.stringify(openAiGenerationRequest(request, model)),
            },
          );
          const body = await responseBody(response);
          const parsed = parseOpenAiGeneration(body, model);
          if (!response.ok) {
            throw new MeteredResponseError(
              providerError(body, response.status).message,
              parsed.model,
              parsed.usage,
              parsed.providerRequestId ?? response.headers.get("x-request-id"),
            );
          }
          if (!parsed.text) {
            throw new MeteredResponseError(
              "Provider returned no text",
              parsed.model,
              parsed.usage,
              parsed.providerRequestId ?? response.headers.get("x-request-id"),
            );
          }
          return {
            value: parsed,
            model: parsed.model,
            usage: parsed.usage,
            requestId:
              parsed.providerRequestId ?? response.headers.get("x-request-id"),
          };
        },
        response: (result) => ({
          text: result.value.text,
          model: result.model,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
        }),
      }),
  };
}

export function createEmbeddingClient(
  db: Database,
  options: ClientOptions = {},
): EmbeddingClient {
  const common = clientContext(options);
  const settings = common.config.providers.openai;
  return {
    embed: (request) =>
      runMeteredAttempts(db, common, {
        request,
        provider: "openai",
        model: request.model ?? common.config.embedding,
        settings,
        call: async (context) => {
          const model = request.model ?? common.config.embedding;
          const response = await common.fetch(`${context.baseURL}/embeddings`, {
            method: "POST",
            signal: context.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${context.key}`,
            },
            body: JSON.stringify({
              model,
              input: request.input,
              encoding_format: "float",
            }),
          });
          const body = await responseBody(response);
          const bodyRecord = asRecord(body);
          const actualModel =
            typeof bodyRecord.model === "string" ? bodyRecord.model : model;
          const usage = normalizeOpenAiEmbeddingUsage(bodyRecord.usage);
          if (!response.ok) {
            throw new MeteredResponseError(
              providerError(body, response.status).message,
              actualModel,
              usage,
              response.headers.get("x-request-id"),
            );
          }
          let parsed;
          try {
            parsed = parseOpenAiEmbeddings(
              body,
              model,
              Array.isArray(request.input) ? request.input.length : 1,
            );
          } catch (error) {
            throw new MeteredResponseError(
              error instanceof Error ? error.message : String(error),
              actualModel,
              usage,
              response.headers.get("x-request-id"),
            );
          }
          return {
            value: parsed,
            model: parsed.model,
            usage: parsed.usage,
            requestId: response.headers.get("x-request-id"),
          };
        },
        response: (result) => ({
          embeddings: result.value.embeddings,
          model: result.model,
          inputTokens: result.usage?.inputTokens ?? null,
        }),
      }),
  };
}

function clientContext(options: ClientOptions) {
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

async function runMeteredAttempts<T, R>(
  db: Database,
  common: ReturnType<typeof clientContext>,
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
  const operationId = randomUUID();
  const key = apiKey(options.settings, common.environment);
  const baseURL = providerBaseUrl(
    options.provider as "gemini" | "openai",
    options.settings,
    common.environment,
  );
  let lastError: unknown;
  const external = options.request.signal;
  for (let attempt = 1; attempt <= options.settings.maxAttempts; attempt += 1) {
    if (external?.aborted) throw cancelledError();
    const attemptId = beginApiAttempt(
      db,
      {
        runId: options.request.runId,
        stage: options.request.stage,
        provider: options.provider,
        model: options.model,
        attempt,
        operationId,
        reservationUsd: reserveRequest(
          common.config,
          options.model,
          options.request,
        ),
      },
      common.caps,
    );
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.settings.timeoutMs,
    );
    const cancel = () => controller.abort();
    external?.addEventListener("abort", cancel, { once: true });
    let result: AttemptResult<T> | null = null;
    try {
      result = await options.call({ signal: controller.signal, key, baseURL });
      const price = priceFor(common.config, result.model);
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
      const cancelled = external?.aborted ?? false;
      const timedOut = controller.signal.aborted && !cancelled;
      const metered = error instanceof MeteredResponseError ? error : null;
      finishApiAttempt(db, attemptId, {
        status: cancelled ? "cancelled" : timedOut ? "timed_out" : "error",
        elapsedMs: performance.now() - startedAt,
        usage: result?.usage ?? metered?.usage,
        price:
          result || metered
            ? priceFor(common.config, result?.model ?? metered!.model)
            : null,
        providerRequestId: result?.requestId ?? metered?.requestId,
        actualModel: result?.model ?? metered?.model,
        error: safeError,
      });
      if (cancelled) throw cancelledError();
      if (
        attempt === options.settings.maxAttempts ||
        !retryable(error, timedOut)
      )
        throw safeError;
      await common.sleep(Math.min(1_000 * 2 ** (attempt - 1), 8_000));
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", cancel);
    }
  }
  throw lastError;
}

export function cancelledError(): Error {
  const error = new Error("Request cancelled by the user");
  error.name = "AbortError";
  return error;
}

function retryable(error: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  const match =
    error instanceof Error ? /^HTTP (\d+):/.exec(error.message) : null;
  if (!match) return error instanceof TypeError;
  const status = Number(match[1]);
  return status === 408 || status === 429 || status >= 500;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Provider returned invalid JSON (HTTP ${response.status})`);
  }
}

export type { ModelClient, ModelRequest, ModelResponse, ModelMessage };

/** Conservative byte-based input upper bound plus configured output limit; not billed usage. */
function reserveRequest(
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
