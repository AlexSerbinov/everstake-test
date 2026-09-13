import { button, el, getJson, metric } from "../../shared/dom.js";
import type {
  UpdateController,
  UpdateJob,
} from "../../../src/services/updates/controller.js";
import type { UpdateSettings } from "../../../src/services/updates/settings.js";
type Status = ReturnType<UpdateController["status"]>;

export function updatesPage(): { node: HTMLElement; destroy: () => void } {
  const node = el("section", "updates-page explore-page");
  const header = el("div", "page-heading");
  header.append(
    el("p", "eyebrow", "CORPUS MAINTENANCE"),
    el("h1", "", "Updates"),
    el(
      "p",
      "muted",
      "Keep sources current. Add new evidence while preserving existing documents and answers.",
    ),
  );
  const message = el("p", "notice", "Loading update settings…");
  message.setAttribute("role", "status");
  const overview = el("div", "metrics");
  const controls = el("div", "update-controls");
  const progress = el("div", "update-progress");
  const history = el("div", "update-history");
  const hero = el("div", "update-hero");
  const heroCopy = el("div");
  heroCopy.append(
    el("span", "eyebrow", "FRESH EVIDENCE, SAME TRUST"),
    el("h2", "", "Bring your knowledge up to date"),
    el(
      "p",
      "",
      "Check every enabled source, discover new videos, and publish verified evidence. Your existing knowledge stays safe.",
    ),
  );
  const runButton = button(
    "Update knowledge base",
    () => {
      // Follow the action displayed when clicked, even if the server pass just finished.
      if (viewingActiveBatch) {
        progress.scrollIntoView({ block: "start", behavior: "smooth" });
        void load(false).catch((error) => {
          if (!disposed) message.textContent = (error as Error).message;
        });
        return;
      }
      void mutate("/api/updates/run", "POST", {});
    },
    "button primary update-start",
  );
  runButton.disabled = true;
  hero.append(heroCopy, runButton);
  node.append(header, hero, message, progress, overview, controls, history);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let settings: UpdateSettings;
  let data: Status;

  let viewingActiveBatch = false;
  let mutating = false;
  let displayedJobs = "";
  const buttons: HTMLButtonElement[] = [runButton];
  const sourceTimes = new Map<string, HTMLElement>();
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString() : "Not checked yet";
  const lockButtons = () =>
    buttons.forEach((b) => {
      b.disabled = mutating;
    });
  async function mutate(path: string, method: string, body: unknown) {
    if (mutating) return;
    mutating = true;
    lockButtons();
    message.textContent = path.endsWith("settings")
      ? "Saving settings…"
      : "Starting your update…";
    try {
      const response = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Update request failed");
      message.textContent = path.endsWith("settings")
        ? "Settings saved. Automatic updates run while the application is running."
        : result.jobs.length
          ? "Update queued. You can leave this page; the worker continues."
          : "No enabled sources matched this request. Check advanced settings.";
      await load(false);
    } catch (error) {
      if (!disposed) message.textContent = (error as Error).message;
    } finally {
      mutating = false;
      lockButtons();
    }
  }
  function action(label: string, callback: () => void, primary = false) {
    const b = button(
      label,
      callback,
      primary ? "button primary" : "button secondary",
    );
    buttons.push(b);
    return b;
  }
  function checkbox(
    label: string,
    checked: boolean,
    change: (value: boolean) => void,
  ) {
    const row = el("label", "update-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => change(input.checked));
    row.append(input, el("span", "", label));
    return row;
  }
  function number(
    label: string,
    value: number,
    min: number,
    max: number,
    change: (value: number) => void,
  ) {
    const row = el("label", "update-field", label);
    const input = el("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(value);
    input.addEventListener("input", () => change(input.valueAsNumber));
    row.append(input);
    return row;
  }
  function buildControls() {
    settings = structuredClone(data.settings);
    const access = el("details", "update-panel update-advanced");
    access.append(el("summary", "", "Advanced settings"));
    access.append(
      checkbox("Enable automatic updates", settings.automatic, (value) => {
        settings.automatic = value;
      }),
      number(
        "Maximum new videos per run",
        settings.youtubeMaximumVideos,
        1,
        20,
        (value) => {
          settings.youtubeMaximumVideos = value;
        },
      ),
      el(
        "p",
        "muted",
        "YouTube checks the official channel and configured searches. Existing video IDs are skipped; new videos are screened, transcribed with Soniox and reviewed before indexing. Remaining videos wait for a later run.",
      ),
    );
    const actions = el("div", "update-actions");
    actions.append(
      action(
        "Save settings",
        () => void mutate("/api/updates/settings", "PUT", settings),
        true,
      ),
      action(
        "Check due sources",
        () => void mutate("/api/updates/run", "POST", { due: true }),
      ),
      action(
        "Update all enabled sources",
        () => void mutate("/api/updates/run", "POST", {}),
      ),
    );
    const sourceLabel = el("label", "update-field", "Source to update now");
    const sourceSelect = el("select");
    for (const source of data.sources) {
      const option = el("option", "", source.label);
      option.value = source.id;
      sourceSelect.append(option);
    }
    sourceLabel.append(sourceSelect);
    access.append(
      sourceLabel,
      action(
        "Update selected source",
        () =>
          void mutate("/api/updates/run", "POST", {
            sourceId: sourceSelect.value,
          }),
      ),
    );
    access.append(
      actions,
      el(
        "p",
        "muted",
        "Run buttons use saved settings. Manual updates bypass the interval, while source limits and API budgets still apply. Higher priority runs first; it does not affect source authority.",
      ),
    );
    const sources = el("div", "update-sources");
    for (const source of data.sources) {
      const preference = settings.sources[source.id];
      const card = el("article", "update-source");
      const time = el("p", "muted");
      sourceTimes.set(source.id, time);
      card.append(
        el("h3", "", source.label),
        checkbox("Include this source", preference.enabled, (value) => {
          preference.enabled = value;
        }),
        number(
          "Check every (hours)",
          preference.intervalHours,
          1,
          8760,
          (value) => {
            preference.intervalHours = value;
          },
        ),
        number("Priority", preference.priority, 0, 100, (value) => {
          preference.priority = value;
        }),
        time,
        action(
          "Update now",
          () =>
            void mutate("/api/updates/run", "POST", { sourceId: source.id }),
        ),
      );
      sources.append(card);
    }
    const schedules = el("details", "update-panel");
    schedules.append(
      el(
        "summary",
        "",
        `Source schedules and priorities (${data.sources.length})`,
      ),
      sources,
    );
    access.append(schedules);
    controls.replaceChildren(access);
    lockButtons();
  }
  function renderStatus() {
    renderProgress();
    overview.replaceChildren(
      metric("Automatic", data.settings.automatic ? "On" : "Off"),
      metric(
        "Queued",
        String(data.jobs.filter((j) => j.status === "queued").length),
      ),
      metric(
        "Running",
        String(data.jobs.filter((j) => j.status === "running").length),
      ),
      metric("Corpus version", data.corpusVersion),
    );
    for (const source of data.sources) {
      const line = sourceTimes.get(source.id);
      if (line)
        line.textContent = `Last checked: ${date(source.lastCheckedAt)}. ${!data.settings.automatic || !data.settings.sources[source.id].enabled ? "Automatic checks paused." : `Next eligible: ${source.nextCheckAt ? date(source.nextCheckAt) : "Now"}.`}`;
    }
    const jobSignature = JSON.stringify({
      jobs: data.jobs,
      enabledSources: Object.fromEntries(
        Object.entries(data.settings.sources).map(([id, source]) => [
          id,
          source.enabled,
        ]),
      ),
    });
    if (jobSignature === displayedJobs) return;
    displayedJobs = jobSignature;
    const openJobs = new Set(
      Array.from(
        history.querySelectorAll<HTMLDetailsElement>("details[open]"),
      ).map((d) => d.dataset.jobId),
    );
    const title = el("h2", "", "Update history");
    history.replaceChildren(
      title,
      el(
        "p",
        "muted",
        "One source runs at a time. Interrupted or failed work can be retried with Update now; completed video processing is reused.",
      ),
    );
    if (!data.jobs.length) history.append(el("p", "", "No update jobs yet."));
    for (const job of data.jobs.slice(0, 30)) {
      const card = jobCard(job);
      const details = card.querySelector("details");
      if (details && openJobs.has(job.id)) details.open = true;
      history.append(card);
    }
  }
  function jobCard(job: UpdateJob) {
    const card = el("article", `update-job ${job.status}`);
    card.append(
      el("h3", "", `${job.sourceId} · ${job.status}`),
      el("p", "", job.phase),
      el("p", "muted", `${date(job.createdAt)} · ${job.trigger}`),
    );
    if (job.error) card.append(el("p", "notice", job.error));
    if (job.result) {
      const details = el("details");
      details.dataset.jobId = job.id;
      details.append(
        el("summary", "", "Counts and measured costs"),
        el("pre", "update-result", JSON.stringify(job.result, null, 2)),
      );
      card.append(details);
    }
    if (["failed", "interrupted"].includes(job.status)) {
      const retry = button(
        "Retry this source",
        () =>
          void mutate("/api/updates/run", "POST", { sourceId: job.sourceId }),
      );
      retry.disabled = !data.settings.sources[job.sourceId]?.enabled;
      card.append(retry);
    }
    return card;
  }
  function renderProgress() {
    const jobs = data.batchJobs;
    const completed = jobs.filter((job) => job.status === "completed").length;
    const failed = jobs.filter((job) =>
      ["failed", "interrupted"].includes(job.status),
    ).length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const running = jobs.find((job) => job.status === "running");
    const active = Boolean(running || queued);
    viewingActiveBatch = active;
    runButton.textContent = active
      ? "View ongoing update"
      : "Update knowledge base";
    const heading = !jobs.length
      ? "Ready for a fresh pass"
      : active
        ? "Updating your knowledge base"
        : failed
          ? "Update finished with issues"
          : "Knowledge base updated";
    const description = !jobs.length
      ? `${data.sources.filter((source) => data.settings.sources[source.id].enabled).length} enabled sources. Start an update to see real progress here.`
      : running
        ? `${data.sources.find((source) => source.id === running.sourceId)?.label ?? running.sourceId}: ${running.phase}`
        : queued
          ? "Queued. The worker starts when the current question or update finishes."
          : failed
            ? `${completed} sources completed; ${failed} need attention. Retry failed sources below.`
            : "All sources in this pass completed. Recorded results are available below.";
    const title = el("div", "update-progress-title");
    title.append(
      el("h2", "", heading),
      el(
        "span",
        "badge",
        jobs.length
          ? `${completed + failed} / ${jobs.length} finished`
          : "Ready",
      ),
    );
    const phase = el("p", "update-current-phase", description);
    phase.setAttribute("role", "status");
    const bar = el("progress", "update-progress-bar");
    bar.max = Math.max(jobs.length, 1);
    bar.value = completed + failed;
    bar.setAttribute(
      "aria-label",
      "Sources finished, including failed sources",
    );
    const counts = el("div", "update-counts");
    for (const [label, count] of [
      ["Completed", completed],
      ["Running", running ? 1 : 0],
      ["Queued", queued],
      ["Failed", failed],
    ] as const) {
      counts.append(metric(label, String(count)));
    }
    const queue = el("div", "update-pass-sources");
    for (const job of jobs) {
      const row = el("div", `update-pass-source ${job.status}`);
      row.append(
        el("span", "update-status-dot"),
        el(
          "strong",
          "",
          data.sources.find((source) => source.id === job.sourceId)?.label ??
            job.sourceId,
        ),
        el("span", "", job.status === "running" ? job.phase : job.status),
      );
      queue.append(row);
    }
    progress.replaceChildren(title, phase, bar, counts, queue);
  }
  async function load(initial: boolean) {
    data = await getJson<Status>("/api/updates", abort.signal);
    if (disposed) return;
    if (initial) {
      buildControls();
      message.textContent =
        "Updates continue in the background. You can leave this page and return to check progress.";
    }
    renderStatus();
  }
  async function poll() {
    try {
      await load(false);
    } catch (error) {
      if (!disposed) message.textContent = (error as Error).message;
    }
    if (!disposed) timer = setTimeout(() => void poll(), 3000);
  }
  void load(true)
    .then(() => {
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    })
    .catch((error) => {
      if (!disposed) message.textContent = error.message;
    });
  return {
    node,
    destroy() {
      disposed = true;
      abort.abort();
      if (timer) clearTimeout(timer);
    },
  };
}
