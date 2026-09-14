import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type {
  PriceEntry,
  PriceSnapshot,
} from "../services/measurements/types.js";

export interface ProviderSettings {
  protocol?: "native" | "openai-compatible" | "auto";
  baseURL: string;
  apiKeyEnv: string;
  timeoutMs: number;
  maxAttempts: number;
}

export interface ModelsConfig {
  answer: string;
  extraction: string;
  embedding: string;
  pricesAsOf: string;
  providers: { gemini: ProviderSettings; openai: ProviderSettings };
  unknownCallReserveUsd: number;
  prices: Record<string, PriceEntry>;
}

const httpUrl = z.url().refine((url) => /^https?:\/\//.test(url));
const providerSchema = z
  .object({
    protocol: z.enum(["native", "openai-compatible", "auto"]).optional(),
    baseURL: httpUrl,
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    timeoutMs: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
  })
  .strict();
const priceSchema = z
  .object({
    inputPerMillionUsd: z.number().nonnegative(),
    cachedInputPerMillionUsd: z.number().nonnegative().optional(),
    outputPerMillionUsd: z.number().nonnegative(),
    source: httpUrl,
    note: z.string().optional(),
  })
  .strict();

export const modelsSchema = z
  .object({
    answer: z.string().min(1),
    extraction: z.string().min(1),
    embedding: z.string().min(1),
    pricesAsOf: z.iso.date(),
    providers: z
      .object({ gemini: providerSchema, openai: providerSchema })
      .strict(),
    unknownCallReserveUsd: z.number().positive(),
    // A newly selected model may lack a price; accounting must then report unknown cost.
    prices: z.record(z.string().min(1), priceSchema),
  })
  .strict();

export function loadModelsConfig(): ModelsConfig {
  return modelsSchema.parse(
    parse(readFileSync("assistant/config/models.yaml", "utf8")),
  );
}

export function priceFor(
  config: ModelsConfig,
  model: string,
): PriceSnapshot | null {
  const price = config.prices[model];
  return price ? { ...price, model, pricesAsOf: config.pricesAsOf } : null;
}

export function apiKey(
  settings: ProviderSettings,
  environment: NodeJS.ProcessEnv,
): string {
  const key = environment[settings.apiKeyEnv];
  if (!key) throw new Error(`Missing API key in ${settings.apiKeyEnv}`);
  return key;
}

export function providerBaseUrl(
  provider: "gemini" | "openai",
  settings: ProviderSettings,
  environment: NodeJS.ProcessEnv,
): string {
  const override =
    provider === "gemini"
      ? (environment.GEMINI_API_BASE_URL ?? environment.GEMINI_BASE_URL)
      : (environment.OPENAI_API_BASE_URL ?? environment.OPENAI_BASE_URL);
  return (override?.trim() || settings.baseURL).replace(/\/+$/, "");
}

export function geminiProtocol(
  settings: ProviderSettings,
  baseURL: string,
  environment: NodeJS.ProcessEnv,
): "native" | "openai-compatible" {
  const configured =
    environment.GEMINI_API_PROTOCOL ?? settings.protocol ?? "native";
  if (configured === "native" || configured === "openai-compatible")
    return configured;
  if (configured !== "auto")
    throw new Error(`Unsupported Gemini protocol: ${configured}`);
  return baseURL.includes("generativelanguage.googleapis.com")
    ? "native"
    : "openai-compatible";
}
