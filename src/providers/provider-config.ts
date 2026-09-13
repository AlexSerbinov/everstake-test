import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { PriceEntry, PriceSnapshot } from '../services/measurements/types.js';

export interface ProviderSettings {
  protocol?: 'native' | 'openai-compatible' | 'auto';
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

export function loadModelsConfig(): ModelsConfig {
  return parse(readFileSync('config/models.yaml', 'utf8')) as ModelsConfig;
}

export function priceFor(config: ModelsConfig, model: string): PriceSnapshot | null {
  const price = config.prices[model];
  return price ? { ...price, model, pricesAsOf: config.pricesAsOf } : null;
}

export function apiKey(settings: ProviderSettings, environment: NodeJS.ProcessEnv): string {
  const key = environment[settings.apiKeyEnv];
  if (!key) throw new Error(`Missing API key in ${settings.apiKeyEnv}`);
  return key;
}

export function providerBaseUrl(
  provider: 'gemini' | 'openai',
  settings: ProviderSettings,
  environment: NodeJS.ProcessEnv,
): string {
  const override = provider === 'gemini'
    ? environment.GEMINI_API_BASE_URL ?? environment.GEMINI_BASE_URL
    : environment.OPENAI_API_BASE_URL ?? environment.OPENAI_BASE_URL;
  return (override ?? settings.baseURL).replace(/\/+$/, '');
}

export function geminiProtocol(settings: ProviderSettings, baseURL: string, environment: NodeJS.ProcessEnv): 'native' | 'openai-compatible' {
  const configured = environment.GEMINI_API_PROTOCOL ?? settings.protocol ?? 'native';
  if (configured === 'native' || configured === 'openai-compatible') return configured;
  if (configured !== 'auto') throw new Error(`Unsupported Gemini protocol: ${configured}`);
  return baseURL.includes('generativelanguage.googleapis.com') ? 'native' : 'openai-compatible';
}
