import type { ModelRequest } from "../contracts.js";
import { normalizeGeminiUsage } from "../services/measurements/pricing.js";
import type { NormalizedUsage } from "../services/measurements/types.js";

export interface ParsedGeneration {
  text: string;
  model: string;
  usage: NormalizedUsage | null;
  providerRequestId: string | null;
}

export function nativeGeminiRequest(
  request: ModelRequest,
  model: string,
): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map((message) => ({
      role: message.role,
      parts: [{ text: message.text }],
    })),
    generationConfig: {
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: request.thinkingLevel } }
        : {}),
    },
  };
}

export function parseNativeGemini(
  body: unknown,
  requestedModel: string,
): ParsedGeneration {
  const data = record(body);
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const candidate = record(candidates[0]);
  const content = record(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts
    .map((part) => record(part))
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
  return {
    text,
    model:
      typeof data.modelVersion === "string"
        ? data.modelVersion
        : requestedModel,
    usage: normalizeGeminiUsage(data.usageMetadata),
    providerRequestId:
      typeof data.responseId === "string" ? data.responseId : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
