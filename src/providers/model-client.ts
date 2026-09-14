import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelMessage,
} from "../contracts.js";
import type { Database } from "../storage/database.js";
import { normalizeOpenAiEmbeddingUsage } from "../services/measurements/pricing.js";
import { nativeGeminiRequest, parseNativeGemini } from "./gemini.js";
import {
  openAiGenerationRequest,
  parseOpenAiEmbeddings,
  parseOpenAiGeneration,
  providerError,
} from "./openai.js";
import { geminiProtocol, providerBaseUrl } from "./provider-config.js";
import {
  createClientContext,
  MeteredResponseError,
  runMeteredAttempts,
  type ClientOptions,
} from "./metered-request.js";

// Keep these exports stable for services that already import this client.
export { cancelledError, type ClientOptions } from "./metered-request.js";

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

export function createModelClient(
  db: Database,
  options: ClientOptions = {},
): ModelClient {
  const client = createClientContext(options);
  const settings = client.config.providers.gemini;
  const baseURL = providerBaseUrl("gemini", settings, client.environment);
  const protocol = geminiProtocol(settings, baseURL, client.environment);
  return {
    generate: (request) =>
      runMeteredAttempts(db, client, {
        request,
        provider: "gemini",
        model: request.model ?? client.config.answer,
        settings,
        call: async (context) => {
          const model = request.model ?? client.config.answer;
          if (protocol === "native") {
            const response = await client.fetch(
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
          const response = await client.fetch(
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
  const client = createClientContext(options);
  const settings = client.config.providers.openai;
  return {
    embed: (request) =>
      runMeteredAttempts(db, client, {
        request,
        provider: "openai",
        model: request.model ?? client.config.embedding,
        settings,
        call: async (context) => {
          const model = request.model ?? client.config.embedding;
          const response = await client.fetch(`${context.baseURL}/embeddings`, {
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
          // Validate the vectors after reading usage so malformed output is
          // still recorded as a paid attempt when the provider reports tokens.
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
