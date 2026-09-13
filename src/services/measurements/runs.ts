import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Database } from "../../storage/database.js";
import type { RunStatus } from "./types.js";

interface ActiveMeasurement {
  cpu: NodeJS.CpuUsage;
  peakRssBytes: number;
}

const runContext = new AsyncLocalStorage<string>();
const activeMeasurements = new Map<string, ActiveMeasurement>();

export function currentRunId(): string | undefined {
  return runContext.getStore();
}

export function beginRun(
  db: Database,
  kind: string,
  metadata: Record<string, unknown> = {},
): string {
  const id = randomUUID();
  const parentRunId =
    typeof metadata.parentRunId === "string"
      ? metadata.parentRunId
      : currentRunId();
  const persistedMetadata = parentRunId
    ? { ...metadata, parentRunId }
    : metadata;
  db.prepare(
    "INSERT INTO runs(id, kind, started_at, finished_at, status, metadata) VALUES (?, ?, ?, NULL, ?, ?)",
  ).run(
    id,
    kind,
    new Date().toISOString(),
    "running",
    JSON.stringify(persistedMetadata),
  );
  activeMeasurements.set(id, {
    cpu: process.cpuUsage(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  });
  return id;
}

export function finishRun(db: Database, id: string, status: RunStatus): void {
  if (status === "running")
    throw new Error("A finished run cannot have status running");
  const row = db
    .prepare("SELECT metadata, status FROM runs WHERE id = ?")
    .get(id) as
    | {
        metadata: string;
        status: string;
      }
    | undefined;
  if (!row) throw new Error(`Unknown run: ${id}`);
  if (row.status !== "running")
    throw new Error(`Run is already finished: ${id}`);

  const metadata = parseObject(row.metadata);
  const active = activeMeasurements.get(id);
  const cpu = active ? process.cpuUsage(active.cpu) : null;
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const measurement = {
    cpuMs: cpu ? (cpu.user + cpu.system) / 1000 : null,
    peakRssBytes: active
      ? Math.max(active.peakRssBytes, peakRssBytes)
      : peakRssBytes,
    resourceScope: "process",
  };
  db.prepare(
    "UPDATE runs SET finished_at = ?, status = ?, metadata = ? WHERE id = ? AND status = 'running'",
  ).run(
    new Date().toISOString(),
    status,
    JSON.stringify({ ...metadata, measurement }),
    id,
  );
  activeMeasurements.delete(id);
}

export async function withRun<T>(
  db: Database,
  kind: string,
  work: (runId: string) => Promise<T>,
  metadata: Record<string, unknown> = {},
): Promise<T> {
  const id = beginRun(db, kind, metadata);
  return runContext.run(id, async () => {
    try {
      const result = await work(id);
      finishRun(db, id, "completed");
      return result;
    } catch (error) {
      finishRun(db, id, "failed");
      throw error;
    }
  });
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
