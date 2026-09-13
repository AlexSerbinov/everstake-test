import { randomUUID } from "node:crypto";
import {
  getSetting,
  setSetting,
  type Database,
} from "../../storage/database.js";
import { sanitizeError } from "../measurements/api-calls.js";
import {
  nextSourceCheck,
  readUpdateSettings,
  saveUpdateSettings,
  updateSources,
  type UpdateSettings,
  type UpdateSource,
} from "./settings.js";

export interface UpdateJob {
  id: string;
  sourceId: string;
  trigger: "manual" | "schedule";
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  phase: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}
export interface UpdateRequest {
  sourceId?: string;
  due?: boolean;
}
export function createUpdateController(
  db: Database,
  execute: (
    sourceId: string,
    settings: UpdateSettings,
    progress: (phase: string) => void,
  ) => Promise<unknown>,
  options: {
    sources?: () => UpdateSource[];
    available?: () => boolean;
    now?: () => number;
  } = {},
) {
  const sources = options.sources ?? updateSources;
  const now = options.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  let working = false;
  let timer: NodeJS.Timeout | undefined;
  const jobs = (): UpdateJob[] =>
    db
      .prepare("SELECT value FROM settings WHERE key LIKE 'update_job:%'")
      .all()
      .map((r) => JSON.parse(String(r.value)) as UpdateJob)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const save = (job: UpdateJob) => {
    job.updatedAt = timestamp();
    setSetting(db, `update_job:${job.id}`, JSON.stringify(job));
  };
  const lease = () =>
    JSON.parse(getSetting(db, "update_worker", "null")) as {
      token: string;
      expires: number;
    } | null;
  function recover() {
    if ((lease()?.expires ?? 0) > now()) return;
    for (const job of jobs().filter((j) => j.status === "running")) {
      job.status = "interrupted";
      job.phase = "interrupted";
      job.error =
        "Worker stopped. Retry this source; completed transcription jobs remain cached.";
      save(job);
    }
  }
  function enqueue(
    request: UpdateRequest = {},
    trigger: "manual" | "schedule" = "manual",
  ) {
    const settings = readUpdateSettings(db, sources());
    if (request.sourceId && !sources().some((s) => s.id === request.sourceId))
      throw new Error("Unknown source ID");
    const selected = sources()
      .filter(
        (s) =>
          settings.sources[s.id].enabled &&
          (!request.sourceId || s.id === request.sourceId),
      )
      .filter(
        (s) =>
          !request.due ||
          !nextSourceCheck(db, s.id, settings) ||
          Date.parse(nextSourceCheck(db, s.id, settings)!) <= now(),
      )
      .sort(
        (a, b) =>
          settings.sources[b.id].priority - settings.sources[a.id].priority,
      );
    if (request.sourceId && !selected.length && !request.due)
      throw new Error("This source is disabled");
    db.exec("BEGIN IMMEDIATE");
    try {
      recover();
      const existing = jobs();
      const accepted = selected.map((s) => {
        const duplicate = existing.find(
          (j) =>
            j.sourceId === s.id && ["queued", "running"].includes(j.status),
        );
        if (duplicate) {
          if (trigger === "manual" && duplicate.status === "queued") {
            duplicate.trigger = "manual";
            save(duplicate);
          }
          return duplicate;
        }
        const job: UpdateJob = {
          id: randomUUID(),
          sourceId: s.id,
          trigger,
          status: "queued",
          phase: "queued",
          createdAt: timestamp(),
          updatedAt: timestamp(),
        };
        save(job);
        return job;
      });
      db.exec("COMMIT");
      return accepted;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  async function tick() {
    if (working || options.available?.() === false) return;
    recover();
    const preferences = readUpdateSettings(db, sources());
    const queued = jobs().some(
      (j) =>
        j.status === "queued" &&
        (preferences.automatic || j.trigger === "manual"),
    );
    const due =
      preferences.automatic &&
      sources().some(
        (s) =>
          preferences.sources[s.id].enabled &&
          (!nextSourceCheck(db, s.id, preferences) ||
            Date.parse(nextSourceCheck(db, s.id, preferences)!) <= now()),
      );
    if (!queued && !due) return;
    working = true;
    const token = randomUUID();
    let owned = false;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        if ((lease()?.expires ?? 0) > now()) {
          db.exec("COMMIT");
          return;
        }
        recover();
        setSetting(
          db,
          "update_worker",
          JSON.stringify({ token, expires: now() + 180_000 }),
        );
        owned = true;
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      heartbeat = setInterval(() => {
        try {
          if (lease()?.token === token)
            setSetting(
              db,
              "update_worker",
              JSON.stringify({ token, expires: now() + 180_000 }),
            );
        } catch (error) {
          console.error("Update lease renewal failed:", sanitizeError(error));
        }
      }, 30_000);
      heartbeat.unref();
      const settings = readUpdateSettings(db, sources());
      if (settings.automatic) enqueue({ due: true }, "schedule");
      const job = jobs()
        .filter(
          (j) =>
            j.status === "queued" &&
            (settings.automatic || j.trigger === "manual"),
        )
        .sort(
          (a, b) =>
            (settings.sources[b.sourceId]?.priority ?? 0) -
              (settings.sources[a.sourceId]?.priority ?? 0) ||
            a.createdAt.localeCompare(b.createdAt),
        )[0];
      if (!job) return;
      job.status = "running";
      job.phase = "starting";
      save(job);
      setSetting(db, `update_attempted:${job.sourceId}`, timestamp());
      try {
        if (
          !settings.sources[job.sourceId]?.enabled ||
          !sources().some((s) => s.id === job.sourceId)
        )
          throw new Error("Source was disabled or removed before execution");
        job.result = await execute(job.sourceId, settings, (phase) => {
          if (lease()?.token !== token || (lease()?.expires ?? 0) <= now())
            throw new Error("Update worker lease was lost");
          job.phase = phase;
          save(job);
        });
        job.status = "completed";
        job.phase = "done";
        setSetting(db, `source_checked:${job.sourceId}`, timestamp());
      } catch (e) {
        job.status = "failed";
        job.phase = "failed";
        job.error = sanitizeError(e);
      }
      save(job);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (owned && lease()?.token === token)
        setSetting(db, "update_worker", "null");
      working = false;
    }
  }
  return {
    enqueue,
    tick,
    status() {
      recover();
      const settings = readUpdateSettings(db, sources());
      return {
        settings,
        sources: sources().map((s) => ({
          ...s,
          lastCheckedAt: getSetting(db, `source_checked:${s.id}`) || null,
          nextCheckAt: nextSourceCheck(db, s.id, settings),
        })),
        jobs: jobs().reverse().slice(0, 100),
        corpusVersion: getSetting(db, "corpus_version", "unbuilt"),
        operatorConfigured: Boolean(process.env.ADMIN_TOKEN),
      };
    },
    configure(input: unknown) {
      return saveUpdateSettings(db, input, sources());
    },
    start() {
      if (timer) return;
      const run = () => {
        void tick().catch((error) =>
          console.error("Update worker failed:", sanitizeError(error)),
        );
      };
      timer = setInterval(run, 1000);
      timer.unref();
      run();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type UpdateController = ReturnType<typeof createUpdateController>;
