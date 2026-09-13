import type { NormalizedUsage, PriceSnapshot } from './types.js';

export function calculateCost(usage: NormalizedUsage, price: PriceSnapshot): number {
  return (
    usage.inputTokens * price.inputPerMillionUsd
    + usage.cachedInputTokens * (price.cachedInputPerMillionUsd ?? price.inputPerMillionUsd)
    + usage.outputTokens * price.outputPerMillionUsd
  ) / 1_000_000;
}

export function normalizeGeminiUsage(raw: unknown): NormalizedUsage | null {
  const value = asRecord(raw);
  const prompt = tokenCount(value.promptTokenCount);
  const visibleOutput = tokenCount(value.candidatesTokenCount);
  if (prompt === null || visibleOutput === null) return null;
  const cached = tokenCount(value.cachedContentTokenCount) ?? 0;
  const thinking = tokenCount(value.thoughtsTokenCount) ?? 0;
  if (cached > prompt) return null;
  return {
    inputTokens: prompt - cached,
    cachedInputTokens: cached,
    outputTokens: visibleOutput + thinking,
    visibleOutputTokens: visibleOutput,
    thinkingTokens: thinking,
    raw,
  };
}

export function normalizeOpenAiUsage(raw: unknown): NormalizedUsage | null {
  const value = asRecord(raw);
  const prompt = tokenCount(value.prompt_tokens ?? value.input_tokens);
  const completion = tokenCount(value.completion_tokens ?? value.output_tokens);
  if (prompt === null || completion === null) return null;
  const promptDetails = asRecord(value.prompt_tokens_details);
  const completionDetails = asRecord(value.completion_tokens_details);
  const cached = tokenCount(promptDetails.cached_tokens) ?? 0;
  const reasoning = tokenCount(completionDetails.reasoning_tokens) ?? 0;
  if (cached > prompt || reasoning > completion) return null;
  return {
    inputTokens: prompt - cached,
    cachedInputTokens: cached,
    outputTokens: completion,
    visibleOutputTokens: completion - reasoning,
    thinkingTokens: reasoning,
    raw,
  };
}

export function normalizeOpenAiEmbeddingUsage(raw: unknown): NormalizedUsage | null {
  const value = asRecord(raw);
  const prompt = tokenCount(value.prompt_tokens ?? value.input_tokens ?? value.total_tokens);
  if (prompt === null) return null;
  return { inputTokens: prompt, cachedInputTokens: 0, outputTokens: 0, raw };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
