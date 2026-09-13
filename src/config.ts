import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { SourceConfig } from "./contracts.js";
export function readConfig<T>(name: string): T {
  return parse(readFileSync(`config/${name}.yaml`, "utf8")) as T;
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
