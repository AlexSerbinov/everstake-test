// The scheduler: an in-process timer that runs `refresh()` when something is due.
//
// Two ways it runs, one implementation:
//   · `npm run serve` starts it inside the API process when `freshness.scheduler.enabled` is
//     true (or `REFRESH_SCHEDULER=1` in the environment). Off by default, so a local server, a
//     test and CI never make network requests or spend money without being asked.
//   · `node dist/refresh/schedule.js` (`npm run schedule`) runs it as its own process. That is
//     what the `refresher` service in docker-compose.yml does, sharing the same mounted kb.db as
//     the API container.
//
// Why a timer and not cron: the interval that matters is per source type and lives in the same
// config the UI edits, so a crontab would be a second place to change and a second place to be
// wrong. The loop wakes every `tick_minutes`, asks `refresh()` what is due, and refresh answers
// from `documents.checked_at` — which means a missed tick, a restart or a container reschedule
// costs nothing but a later first run. There is no schedule state to lose.
//
// Serialisation is the one real hazard: two overlapping refreshes would both see the same
// documents as due and both fetch them. `running` below is the guard, and it is per process —
// which is why the compose file runs exactly one refresher container, and why the API's
// in-process scheduler must not be enabled at the same time as that container.

import { getConfig } from "../config.js";
import { withStageMetrics } from "../metrics.js";
import { refresh, summarise } from "./refresh.js";

const MINUTE_MS = 60_000;

export interface SchedulerHandle {
  (): void;
}

/**
 * Start the loop. Returns a function that stops it.
 *
 * `force` bypasses the `enabled` flag — that is how `npm run schedule` starts unconditionally
 * while `npm run serve` still respects the config. Returns a no-op stopper when the scheduler is
 * disabled, so callers never have to branch.
 */
export function startScheduler(opts: { force?: boolean } = {}): SchedulerHandle {
  const cfg = getConfig().freshness.scheduler;
  const enabled = opts.force || cfg.enabled || process.env.REFRESH_SCHEDULER === "1";
  if (!enabled) return () => {};

  const tickMs = Math.max(1, cfg.tick_minutes) * MINUTE_MS;
  let running = false;
  let stopped = false;

  const tick = async () => {
    // Overlap guard. A refresh of a large corpus can outlive a tick; starting a second one would
    // double every conditional GET and race on the same document rows.
    if (running || stopped) return;
    running = true;
    try {
      const result = await withStageMetrics("refresh", () => refresh(), { trigger: "scheduler" });
      // Only say something when something happened: a scheduler that logs "nothing changed"
      // every fifteen minutes trains its operator to stop reading the log.
      if (result.changed || result.added || result.removed || result.errors) {
        console.log(`[scheduler] ${summarise(result)}`);
      }
    } catch (error) {
      console.error("[scheduler] refresh failed:", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, tickMs);
  // Inside the API process the loop must never be the reason the process refuses to exit. As a
  // standalone process (`npm run schedule`) it is the only thing keeping it alive, so it stays
  // referenced there.
  if (!opts.force) timer.unref?.();
  console.log(`[scheduler] on, tick every ${cfg.tick_minutes} min (policy: ${getConfig().freshness.preset})`);
  // Deliberately not implied by `force`: a container that refreshes on every deploy spends money
  // every time it is restarted, which is not what "the scheduler is on" should mean.
  if (cfg.run_on_start) void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Entry point for `node dist/refresh/schedule.js` — the `refresher` service in
 * docker-compose.yml. Starts the loop unconditionally and stays alive until the container stops
 * it; the signal handlers are what keep the event loop referenced.
 *
 * Guarded the same way `src/server/main.ts` is, so importing this module (the API process, a
 * test) never starts a loop as a side effect.
 */
if (process.argv[1]?.endsWith("refresh/schedule.ts") || process.argv[1]?.endsWith("refresh/schedule.js")) {
  const stop = startScheduler({ force: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[scheduler] ${signal}, stopping`);
      stop();
      process.exit(0);
    });
  }
}
