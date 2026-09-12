// Loads config/kb.yaml + config/sources.yaml and .env.
// `getConfig()` returns the live config: file values + in-memory overrides set via PUT /api/config.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

loadDotEnv(path.join(ROOT, ".env"));

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? "./data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
// KB_DB_PATH points the whole process at another index file — used by the adversarial eval,
// which plants poisoned documents into a throw-away copy instead of the real corpus.
export const DB_PATH = process.env.KB_DB_PATH ? path.resolve(process.env.KB_DB_PATH) : path.join(DATA_DIR, "kb.db");
fs.mkdirSync(RAW_DIR, { recursive: true });

export interface KbConfig {
  models: { answer: string; cheap: string; effort: "low" | "medium" | "high" };
  agent: { max_steps: number; live_fetch_allow: string[]; live_cache_minutes: number; mcp_url: string };
  retrieval: { bm25_top: number; vector_top: number; final_top: number; date_diverse_extra: number; rrf_k: number };
  ranking: {
    recency_half_life_days: number;
    recency_floor: number;
    tier_weights: Record<string, number>;
    ai_directed_multiplier: number;
    undated_recency: number;
  };
  gates: { min_best_score: number; require_citations: boolean; require_grounded_numbers: boolean };
  filters: { excluded_domains: string[]; min_published_year: number | null; include_tiers: number[] };
  instructions: { patterns: string[]; ai_directed_paths: string[]; ai_directed_min_hits: number };
  crawl: { user_agent: string; delay_ms: number; timeout_ms: number; retries: number; max_blog_posts: number; youtube_channel_videos: number };
  chunking: { target_chars: number; overlap_chars: number; min_chars: number; min_html_chars: number };
  dedup: { shingle_words: number; minhash_perms: number; same_domain_jaccard: number; cross_domain_containment: number };
  pricing_usd_per_mtok: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }>;
}

export interface SourceDef {
  id: string;
  kind: "sitemap" | "llms-txt" | "urls" | "github-org" | "youtube";
  url?: string;
  urls?: string[];
  org?: string;
  extra_files?: string[];
  videos?: string[];
  channel?: string;
  tier: number;
  category: string;
  notes?: string;
}

export interface SourcesConfig {
  sources: SourceDef[];
  excluded: { domain: string; reason: string; seed_only?: boolean }[];
}

const fileConfig: KbConfig = YAML.parse(fs.readFileSync(path.join(ROOT, "config/kb.yaml"), "utf8"));
export const sourcesConfig: SourcesConfig = YAML.parse(fs.readFileSync(path.join(ROOT, "config/sources.yaml"), "utf8"));

let overrides: Partial<KbConfig> = {};

/** Live config: yaml file + runtime overrides (deep-merged one level per section). */
export function getConfig(): KbConfig {
  const out: any = structuredClone(fileConfig);
  for (const [section, value] of Object.entries(overrides)) {
    out[section] = { ...out[section], ...(value as object) };
  }
  return out as KbConfig;
}

export function setConfigOverrides(patch: Partial<KbConfig>) {
  for (const [section, value] of Object.entries(patch)) {
    overrides = { ...overrides, [section]: { ...(overrides as any)[section], ...(value as object) } };
  }
  return getConfig();
}

export function resetConfigOverrides() {
  overrides = {};
  return getConfig();
}

export const env = {
  llmProvider: (process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.GEMINI_API_KEY ? "gemini" : "openrouter")) as "anthropic" | "openrouter" | "gemini",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  geminiAnswerModel: process.env.GEMINI_ANSWER_MODEL ?? "gemini-2.5-flash",
  geminiCheapModel: process.env.GEMINI_CHEAP_MODEL ?? "gemini-2.5-flash-lite",
  embeddingsProvider: (process.env.EMBEDDINGS_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai" : process.env.VOYAGE_API_KEY ? "voyage" : "none")) as "openai" | "voyage" | "none",
  openaiKey: process.env.OPENAI_API_KEY ?? "",
  voyageKey: process.env.VOYAGE_API_KEY ?? "",
  port: Number(process.env.PORT ?? 4320),
};

function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
