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
  const history = el("div", "update-history");
  node.append(header, message, overview, controls, history);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let settings: UpdateSettings;
  let data: Status;
  let token = "";
  let mutating = false;
  let displayedJobs = "";
  const buttons: HTMLButtonElement[] = [];
  const sourceTimes = new Map<string, HTMLElement>();
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString() : "Not checked yet";
  const lockButtons = () =>
    buttons.forEach((b) => {
      b.disabled = !token || mutating;
    });
  async function mutate(path: string, method: string, body: unknown) {
    mutating = true;
    lockButtons();
    message.textContent = "Saving…";
    try {
      const response = await fetch(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
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
          : "No sources are due.";
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
    const access = el("div", "update-panel");
    const accessLabel = el("label", "update-field", "Operator token");
    const input = el("input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "Enter your operator token";
    input.addEventListener("input", () => {
      token = input.value.trim();
      lockButtons();
    });
    accessLabel.append(input);
    access.append(
      el("h2", "", "Update settings"),
      accessLabel,
      el(
        "p",
        "muted",
        data.operatorConfigured
          ? "A token is required to save settings or start work. It stays in this page’s memory."
          : "Operator access is not configured. Set ADMIN_TOKEN on the server to enable changes.",
      ),
    );
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
    controls.replaceChildren(access, schedules);
    lockButtons();
  }
  function renderStatus() {
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
    const jobSignature = JSON.stringify(data.jobs);
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
    return card;
  }
  async function load(initial: boolean) {
    data = await getJson<Status>("/api/updates", abort.signal);
    if (disposed) return;
    if (initial) {
      buildControls();
      message.textContent =
        "Saved settings apply to both manual and automatic updates. Existing evidence is retained.";
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
      token = "";
      abort.abort();
      if (timer) clearTimeout(timer);
    },
  };
}
