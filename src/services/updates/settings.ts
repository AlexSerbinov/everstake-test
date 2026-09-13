import { z } from "zod";
import { readSources } from "../../config.js";
import {
  getSetting,
  setSetting,
  type Database,
} from "../../storage/database.js";

export const updateSettingsSchema = z
  .object({
    automatic: z.boolean(),
    sources: z.record(
      z.string(),
      z
        .object({
          enabled: z.boolean(),
          intervalHours: z.number().int().min(1).max(8760),
          priority: z.number().int().min(0).max(100),
        })
        .strict(),
    ),
    youtubeMaximumVideos: z.number().int().min(1).max(20),
  })
  .strict();
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export interface UpdateSource {
  id: string;
  label: string;
  kind: string;
  intervalHours: number;
}
export function updateSources(): UpdateSource[] {
  return [
    ...readSources()
      .filter((s) => s.kind !== "youtube")
      .map((s) => ({
        id: s.id,
        label: s.publisher + " · " + s.id,
        kind: s.kind,
        intervalHours: s.authority === 1 ? 24 : 168,
      })),
    {
      id: "youtube",
      label: "YouTube · new videos",
      kind: "youtube",
      intervalHours: 168,
    },
  ];
}
export function readUpdateSettings(
  db: Database,
  sources = updateSources(),
): UpdateSettings {
  const defaults: UpdateSettings = {
    automatic: false,
    youtubeMaximumVideos: 3,
    sources: Object.fromEntries(
      sources.map((s) => [
        s.id,
        { enabled: true, intervalHours: s.intervalHours, priority: 0 },
      ]),
    ),
  };
  const saved = getSetting(db, "update_settings");
  if (!saved) return defaults;
  const parsed = updateSettingsSchema.parse(JSON.parse(saved));
  return {
    ...parsed,
    sources: Object.fromEntries(
      sources.map((s) => [
        s.id,
        parsed.sources[s.id] ?? defaults.sources[s.id],
      ]),
    ),
  };
}
export function saveUpdateSettings(
  db: Database,
  input: unknown,
  sources = updateSources(),
): UpdateSettings {
  const parsed = updateSettingsSchema.parse(input);
  const ids = new Set(sources.map((s) => s.id));
  if (
    Object.keys(parsed.sources).some((id) => !ids.has(id)) ||
    sources.some((s) => !parsed.sources[s.id])
  )
    throw new Error("Settings must include exactly the configured sources");
  setSetting(db, "update_settings", JSON.stringify(parsed));
  return parsed;
}
export function nextSourceCheck(
  db: Database,
  id: string,
  settings: UpdateSettings,
): string | null {
  const checked = Date.parse(getSetting(db, `source_checked:${id}`));
  const attempted = Date.parse(getSetting(db, `update_attempted:${id}`));
  // Failed sources back off for their configured interval instead of retrying every minute.
  const last = Math.max(
    Number.isFinite(checked) ? checked : 0,
    Number.isFinite(attempted) ? attempted : 0,
  );
  return last
    ? new Date(
        last + settings.sources[id].intervalHours * 3600_000,
      ).toISOString()
    : null;
}
