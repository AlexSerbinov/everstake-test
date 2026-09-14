import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { SourceConfig } from "./contracts.js";
/** Read afresh so edits take effect on the next operation, without restarting the app. */
export function readConfig<T = unknown>(name: string): T {
  const value: unknown = parse(
    readFileSync(`assistant/config/${name}.yaml`, "utf8"),
  );
  // Older consumers use readConfig<...>("policy"); keep that API validated too.
  return (name === "policy" ? policySchema.parse(value) : value) as T;
}

export const policySchema = z
  .object({
    maxEvidence: z.number().int().min(6).max(30),
    maxOutputTokens: z.number().int().positive().max(4000),
    answerThinkingLevel: z.enum(["low", "medium", "high"]).optional(),
    maxRunCostUsd: z.number().positive(),
    maxSessionCostUsd: z.number().positive(),
    trust: z
      .object({
        authority: z.number().nonnegative(),
        temporal: z.number().nonnegative(),
        grounding: z.number().nonnegative(),
        agreement: z.number().nonnegative(),
      })
      .refine(
        (weights) =>
          Object.values(weights).reduce((sum, n) => sum + n, 0) === 100,
        "Trust weights must sum to 100",
      ),
  })
  .strict();

export const researcherSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    skills: z.array(z.string().min(1)),
    maxSteps: z.number().int().min(1).max(8),
    maxRepairSteps: z.number().int().min(0).max(2).default(1),
    // This is an inventory, not a plugin loader. Action validation/dispatch lives in code.
    tools: z
      .array(z.enum(["search", "read", "calculate", "answer"]))
      .refine(
        (tools) => tools.length === 4 && new Set(tools).size === 4,
        "Tools must list exactly search, read, calculate, answer",
      ),
  })
  .strict();

export type PolicyConfig = z.infer<typeof policySchema>;
export type ResearcherConfig = z.infer<typeof researcherSchema>;

export function readPolicy(): PolicyConfig {
  return readConfig<PolicyConfig>("policy");
}

export function readResearcher(): ResearcherConfig {
  return researcherSchema.parse(
    parse(readFileSync("assistant/agents/researcher.yaml", "utf8")),
  );
}
const sourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    url: z.url().refine((value) => /^https?:\/\//.test(value)),
    publisher: z.string().min(1),
    authority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: z.enum(["website", "docs", "news", "github", "youtube"]),
    reason: z.string().min(1),
    enabled: z.boolean(),
    seedUrls: z.array(z.url()).optional(),
    expand: z.boolean().optional(),
  })
  .passthrough();
export function readSources(): SourceConfig[] {
  const result = z
    .object({ sources: z.array(sourceSchema) })
    .parse(readConfig("sources"));
  if (new Set(result.sources.map((s) => s.id)).size !== result.sources.length)
    throw new Error("Source IDs must be unique");
  return result.sources.filter((s) => s.enabled);
}
export const runtime = {
  port: Number(process.env.PORT ?? 4318),
  dbPath: process.env.DB_PATH ?? "data/knowledge.sqlite",
};
