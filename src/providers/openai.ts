import type { ModelRequest } from "../contracts.js";
import {
  normalizeOpenAiEmbeddingUsage,
  normalizeOpenAiUsage,
} from "../services/measurements/pricing.js";
import type { NormalizedUsage } from "../services/measurements/types.js";

export interface OpenAiGeneration {
  text: string;
  model: string;
  usage: NormalizedUsage | null;
  providerRequestId: string | null;
}

export interface OpenAiEmbeddings {
  embeddings: number[][];
  model: string;
  usage: NormalizedUsage | null;
}

export function openAiGenerationRequest(
  request: ModelRequest,
  model: string,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: request.system },
      ...request.messages.map((message) => ({
        role: message.role === "model" ? "assistant" : "user",
        content: message.text,
      })),
    ],
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_tokens: request.maxOutputTokens }),
    ...(request.thinkingLevel
      ? { reasoning_effort: request.thinkingLevel }
      : {}),
  };
}

export function parseOpenAiGeneration(
  body: unknown,
  requestedModel: string,
): OpenAiGeneration {
  const data = record(body);
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = record(record(choices[0]).message);
  const text = contentText(message.content).trim();
  return {
    text,
    model: typeof data.model === "string" ? data.model : requestedModel,
    usage: normalizeOpenAiUsage(data.usage),
    providerRequestId: typeof data.id === "string" ? data.id : null,
  };
}

export function parseOpenAiEmbeddings(
  body: unknown,
  requestedModel: string,
  expectedCount: number,
): OpenAiEmbeddings {
  const value = record(body);
  const data = Array.isArray(value.data) ? value.data : [];
  const embeddings = data
    .map((item) => record(item).embedding)
    .filter(Array.isArray) as number[][];
  if (
    embeddings.length !== expectedCount ||
    embeddings.length === 0 ||
    embeddings.length !== data.length ||
    embeddings.some(
      (vector) =>
        vector.length === 0 ||
        vector.length !== embeddings[0]!.length ||
        vector.some(
          (number) => typeof number !== "number" || !Number.isFinite(number),
        ),
    )
  ) {
    throw new Error("Provider returned invalid embeddings");
  }
  return {
    embeddings,
    model: typeof value.model === "string" ? value.model : requestedModel,
    usage: normalizeOpenAiEmbeddingUsage(value.usage),
  };
}

export function providerError(body: unknown, status: number): Error {
  const data = record(body);
  const nested = record(data.error);
  const message =
    typeof nested.message === "string"
      ? nested.message
      : typeof data.message === "string"
        ? data.message
        : `Provider request failed with HTTP ${status}`;
  return new Error(`HTTP ${status}: ${message}`);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      return typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
