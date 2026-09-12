// Every tunable value in the system, resolved once at import time.
//
// Three sources, in this order of precedence:
//   1. in-memory overrides  — set from the UI via `PUT /api/config`, live, no restart
//   2. `config/kb.yaml`     — the committed defaults (thresholds, weights, prices, models)
//   3. `config/sources.yaml`— the corpus definition: what to crawl, at which tier
// plus `.env` / the real environment for secrets and deployment-specific paths.
//
// The split is deliberate. `kb.yaml` holds the numbers a reviewer may want to challenge on
// the call — recency half-life, gate thresholds, top-k — so they can be changed while the
// system is running instead of argued about in the abstract. `.env` holds only what must not
// be committed (API keys) or what differs per machine (ports, the database path).
//
// What breaks if this is wrong: everything downstream reads `getConfig()` on every call, so
// a bad value does not crash — it silently changes ranking, gating or the price table. A
// wrong price table is the nastiest case: costs in REPORT.md §3 would be self-consistent and
// wrong, because `llm.ts` computes cost from these numbers and the token counts are real.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Project root: this file lives in `src/`, so one level up. Everything else is resolved
 *  from here rather than from `process.cwd()`, so `npm run ask` works from any directory. */
export const ROOT = path.resolve(here, "..");

// Must run before the `process.env` reads below — that is the whole point of a .env file.
loadDotEnv(path.join(ROOT, ".env"));

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR ?? "./data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
// KB_DB_PATH points the whole process at another index file — used by the adversarial eval,
// which plants poisoned documents into a throw-away copy instead of the real corpus.
export const DB_PATH = process.env.KB_DB_PATH ? path.resolve(process.env.KB_DB_PATH) : path.join(DATA_DIR, "kb.db");
fs.mkdirSync(RAW_DIR, { recursive: true });

/** The shape of `config/kb.yaml`. Hand-written rather than derived from a zod schema: the
 *  file is committed and read once, so a parse-time schema would only restate this type. */
export interface KbConfig {
  models: {
    /** Canonical Anthropic id for the final answer; remapped per provider in `llm.ts`. */
    answer: string;
    /** Cheap model for the high-volume passes: fact extraction and the eval judge. */
    cheap: string;
    /** Thinking effort for the answer model only. */
    effort: "low" | "medium" | "high";
  };
  agent: {
    /** Tool calls allowed before `finish` is forced — the cost ceiling for one question. */
    max_steps: number;
    /** Domains `fetch_live_page` may touch at all; robots.txt is still checked on top. */
    live_fetch_allow: string[];
    live_cache_minutes: number;
    mcp_url: string;
  };
  retrieval: {
    bm25_top: number;
    vector_top: number;
    /** Chunks actually handed to the model — the fixed top-k the ×50 cost claim rests on. */
    final_top: number;
    date_diverse_extra: number;
    /** Reciprocal Rank Fusion constant; damps the influence of a single top-1 hit. */
    rrf_k: number;
  };
  ranking: {
    recency_half_life_days: number;
    recency_floor: number;
    /** Source authority by tier, keyed by the tier number as a string (YAML gives strings). */
    tier_weights: Record<string, number>;
    ai_directed_multiplier: number;
    undated_recency: number;
  };
  gates: {
    min_best_score: number;
    require_citations: boolean;
    require_grounded_numbers: boolean;
  };
  filters: {
    excluded_domains: string[];
    min_published_year: number | null;
    include_tiers: number[];
  };
  instructions: {
    /** Regex sources for prompt-injection sentences, compiled in `src/index/instructions.ts`. */
    patterns: string[];
    ai_directed_paths: string[];
    ai_directed_min_hits: number;
  };
  crawl: {
    user_agent: string;
    delay_ms: number;
    timeout_ms: number;
    retries: number;
    max_blog_posts: number;
    youtube_channel_videos: number;
  };
  chunking: {
    target_chars: number;
    overlap_chars: number;
    min_chars: number;
    min_html_chars: number;
  };
  dedup: {
    shingle_words: number;
    minhash_perms: number;
    same_domain_jaccard: number;
    cross_domain_containment: number;
  };
  /** USD per million tokens, per model, per usage bucket. The single input to every cost
   *  figure the system reports; see `priceUsd` in `llm.ts`. */
  pricing_usd_per_mtok: Record<
    string,
    { input: number; output: number; cache_read?: number; cache_write?: number }
  >;
}

/** One entry of `config/sources.yaml`: where a slice of the corpus comes from and how much
 *  the ranker should trust it. `kind` decides which discovery strategy `crawl` uses. */
export interface SourceDef {
  id: string;
  kind: "sitemap" | "llms-txt" | "urls" | "github-org" | "youtube";
  url?: string;
  urls?: string[];
  org?: string;
  extra_files?: string[];
  videos?: string[];
  channel?: string;
  /** 1 = first-party, 2 = press/third-party, 3 = ASR transcripts and social. */
  tier: number;
  category: string;
  notes?: string;
}

export interface SourcesConfig {
  sources: SourceDef[];
  /** Domains kept out of the corpus on purpose, with the reason recorded so the choice is
   *  defensible. `seed_only` still allows a fetch when the URL is listed verbatim. */
  excluded: { domain: string; reason: string; seed_only?: boolean }[];
}

// Read once at import. Neither file is watched: a YAML edit needs a restart, while the live
// knobs go through `setConfigOverrides` instead.
const fileConfig: KbConfig = YAML.parse(fs.readFileSync(path.join(ROOT, "config/kb.yaml"), "utf8"));
export const sourcesConfig: SourcesConfig = YAML.parse(fs.readFileSync(path.join(ROOT, "config/sources.yaml"), "utf8"));

/** Runtime patches from `PUT /api/config`. Process-local and not persisted — a restart is
 *  always a return to the committed configuration, which is what makes experimenting on the
 *  live instance safe. */
let overrides: Partial<KbConfig> = {};

/**
 * The live configuration: the YAML file with the runtime overrides merged over it.
 *
 * Called on every use rather than captured in a module constant, so a knob changed from the
 * Settings panel takes effect on the very next question with no restart and no redeploy —
 * that is the demo the UI is built around.
 *
 * The clone is what makes that safe: callers get a private copy, so a caller mutating what it
 * reads cannot corrupt the defaults for everyone else. `structuredClone` is cheap here (a few
 * hundred scalars) and beats a shallow copy, which would share the nested section objects.
 */
export function getConfig(): KbConfig {
  const merged: any = structuredClone(fileConfig);
  // One level deep on purpose: a patch names a section and the keys inside it, so
  // `{ gates: { require_citations: false } }` flips one gate and leaves the other two alone.
  // Anything nested deeper (`ranking.tier_weights`) is therefore replaced wholesale, not
  // merged — the UI sends that section complete.
  for (const [section, value] of Object.entries(overrides)) {
    merged[section] = { ...merged[section], ...(value as object) };
  }
  return merged as KbConfig;
}

/** Apply a patch and return the resulting live config. Patches accumulate: sending
 *  `{ gates: { require_citations: false } }` twice in a row is the same as sending it once,
 *  and a later patch to `retrieval` does not undo the earlier one to `gates`. */
export function setConfigOverrides(patch: Partial<KbConfig>) {
  for (const [section, value] of Object.entries(patch)) {
    overrides = { ...overrides, [section]: { ...(overrides as any)[section], ...(value as object) } };
  }
  return getConfig();
}

/**
 * Drop every override and go back to `config/kb.yaml`.
 * This is the "undo" behind the Settings panel's reset button, and the thing that makes an
 * eval run trustworthy: a demo that loosened a gate must not leave the instance in that state
 * for the next question.
 */
export function resetConfigOverrides() {
  overrides = {};
  return getConfig();
}

/**
 * Environment-derived settings, read once. Deliberately a mutable plain object rather than
 * frozen constants: `llm.test.ts` swaps `llmProvider` to exercise the model mapping for all
 * three providers without any network access.
 */
export const env = {
  llmProvider: defaultLlmProvider(),
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  openrouterKey: process.env.OPENROUTER_API_KEY ?? "",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  // `config/kb.yaml` names Claude models even on a Gemini run; these two are what those names
  // resolve to. See `resolveModel` in llm.ts and the provider note in REPORT.md §2.8.
  geminiAnswerModel: process.env.GEMINI_ANSWER_MODEL ?? "gemini-3.8-flash",
  geminiCheapModel: process.env.GEMINI_CHEAP_MODEL ?? "gemini-3.5-flash-lite",
  embeddingsProvider: defaultEmbeddingsProvider(),
  openaiKey: process.env.OPENAI_API_KEY ?? "",
  voyageKey: process.env.VOYAGE_API_KEY ?? "",
  port: Number(process.env.PORT ?? 4320),
};

/**
 * Which model provider to use. An explicit `LLM_PROVIDER` always wins; otherwise the provider
 * is inferred from whichever key is present, so a fresh clone with one key in `.env` runs
 * without further configuration. Anthropic first because it is the reference implementation
 * (structured outputs and prompt caching are native there), OpenRouter last as the fallback
 * for machines with no Anthropic account.
 */
function defaultLlmProvider(): "anthropic" | "openrouter" | "gemini" {
  const explicit = process.env.LLM_PROVIDER;
  // `!== undefined`, not a truthiness check: an env var set to the empty string is a
  // configuration mistake and should surface as an unknown provider, not silently re-infer.
  if (explicit !== undefined) return explicit as "anthropic" | "openrouter" | "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "openrouter";
}

/** Same inference for embeddings. "none" is a supported state, not an error: retrieval falls
 *  back to BM25-only and says so in the trace (see `src/embeddings.ts`). */
function defaultEmbeddingsProvider(): "openai" | "voyage" | "none" {
  const explicit = process.env.EMBEDDINGS_PROVIDER;
  if (explicit !== undefined) return explicit as "openai" | "voyage" | "none";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.VOYAGE_API_KEY) return "voyage";
  return "none";
}

/**
 * Minimal `.env` reader — no dotenv dependency for ~10 lines of parsing.
 *
 * Handles exactly what this project's `.env` contains: `KEY=value`, optional surrounding
 * whitespace, optional matching quotes. It does NOT handle multi-line values, escapes or
 * variable expansion; if a key ever needs those, use a real parser rather than growing this.
 *
 * A variable already present in the real environment always wins, so `LLM_PROVIDER=gemini
 * npm run eval` overrides the file for one command without editing it.
 */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    // Matches `NAME = value` with an upper-case/digit/underscore name. Anything else — a
    // comment line, a blank line, a lower-case name — simply does not match and is skipped.
    const assignment = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!assignment || process.env[assignment[1]] !== undefined) continue;
    const [, name, rawValue] = assignment;
    process.env[name] = rawValue.replace(/^["']|["']$/g, "");
  }
}
