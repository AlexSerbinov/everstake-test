/**
 * The live pipeline panel, plus the SSE reader that feeds it.
 *
 * Where this sits in the system: this is the browser end of the answer pipeline
 * (crawl → dedup → index → facts → retrieve → answer → eval). `streamAsk` opens
 * POST /ask/stream and turns raw bytes into typed events; `PipelinePanel` turns
 * those events into the step list the user watches while the agent works.
 *
 * The event contract lives in docs/agentic-spec.md and is shared with the backend
 * (src/ask/agent.ts) and with the demo replay in mock-stream.js. The event names
 * and payload field names spelled out below ARE that contract — renaming one here
 * breaks the panel silently, because an unrecognised event type is simply ignored:
 *
 *   stage       {id,label,status:"start"|"done"|"skip",ms,detail}
 *   tool_call   {step,tool,args,label}
 *   tool_result {step,tool,summary,ms,items[]}
 *   note        {text}
 *   final       <AskResult>
 *   error       {message}
 *
 * This module owns no application state beyond one panel instance; app.js creates
 * a fresh panel per question and calls `destroy()` on the previous one.
 */

/* Only these four characters can break out of the HTML this file builds. A bare
   apostrophe cannot, because every attribute here and in app.js is double-quoted. */
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

const MILLISECONDS_PER_SECOND = 1000;

/* Above ten seconds a second decimal is noise, so timings switch from "4.21 s" to
   "12.3 s". Purely a legibility choice, nothing depends on the precision. */
const COARSE_TIMING_THRESHOLD_MS = 10_000;

/* Below a cent, three decimals would print "$0.003" for every cheap question and
   hide the differences between them, so sub-cent costs get five decimals. */
const SUB_CENT_USD = 0.01;

/**
 * Escape untrusted text before it is interpolated into one of the HTML template
 * strings in this file. Everything the panel shows — page titles, source quotes,
 * tool summaries — was crawled from the public web, so a hostile page could
 * otherwise inject markup straight into the operator's own UI.
 */
export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);

/**
 * "https://www.everstake.com/company/about" → "everstake.com".
 * Used wherever a row has room for the publisher but not the whole URL, and as the
 * fallback label when a source has no title.
 *
 * The catch is load-bearing: fact-ledger rows and synthesised trace rows sometimes
 * carry an empty or relative URL, and `new URL` throws on those. Showing the raw
 * string is better than losing the whole row to an exception mid-render.
 */
export const domainFromUrl = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url || "");
  }
};

/**
 * Render a duration the way an operator reads it while watching the panel: whole
 * milliseconds while a step is still sub-second, seconds once it is not.
 * Returns "" rather than "0 ms" for a missing value, because the backend leaves
 * `ms` out for stages it did not time, and an empty cell reads as "not measured".
 */
export const formatDuration = (milliseconds) => {
  if (milliseconds == null) return "";
  if (milliseconds < MILLISECONDS_PER_SECOND) return `${Math.round(milliseconds)} ms`;
  const decimals = milliseconds < COARSE_TIMING_THRESHOLD_MS ? 2 : 1;
  return `${(milliseconds / MILLISECONDS_PER_SECOND).toFixed(decimals)} s`;
};

/**
 * Format a model-call cost. Cost is one of the graded numbers in this project, so
 * it is shown to whatever precision keeps it non-zero rather than rounded away.
 * An em dash means "not reported" — distinct from a genuine $0.000.
 */
export const formatUsd = (costUsd) => {
  if (costUsd == null) return "—";
  return costUsd < SUB_CENT_USD ? `$${costUsd.toFixed(5)}` : `$${costUsd.toFixed(3)}`;
};

/* Icon and default label per stage id. The keys are the stage ids fixed by
   docs/agentic-spec.md; an id missing from here still renders, with a bullet and
   the raw id as its label, so a new backend stage degrades instead of vanishing. */
const STAGE_DISPLAY = {
  plan:   { icon: "◇", label: "Planning the approach" },
  search: { icon: "⌕", label: "Searching the corpus" },
  facts:  { icon: "▤", label: "Reading the fact ledger" },
  live:   { icon: "⟲", label: "Checking the live page" },
  read:   { icon: "❐", label: "Reading a document" },
  answer: { icon: "✎", label: "Drafting the answer" },
  verify: { icon: "✓", label: "Verifying citations" },
};

/* Keys are the tool names the agent may call (docs/agentic-spec.md § Tools). */
const TOOL_ICONS = {
  search_corpus: "⌕",
  fact_history: "▤",
  get_document: "❐",
  fetch_live_page: "⟲",
  everstake_live_data: "⇄",
  finish: "✓",
};

/* Server-sent events are separated by a blank line; a frame is everything before it. */
const SSE_FRAME_SEPARATOR = "\n\n";

/**
 * Read POST /ask/stream and hand every event to `onEvent(type, data)`.
 *
 * Written on fetch + ReadableStream rather than EventSource because EventSource
 * can only issue GET requests, and the question travels in a JSON body. That is
 * also why the SSE framing below is parsed by hand — nothing in the platform does
 * it for a fetch response.
 *
 * Throws on anything that is not a live event stream so that app.js can fall back
 * to the plain POST /ask endpoint; the caller aborts via `signal`.
 */
export async function streamAsk(url, question, onEvent, signal) {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ question }),
  });
  if (!response.ok || !response.body) throw new Error(`stream unavailable (${response.status})`);

  /* A proxy or an error page will happily return 200 with HTML. Checking the type
     turns that into the fallback path instead of a stream that never emits. */
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error("stream unavailable (not an event stream)");
  }

  await readSseFrames(response.body, (frame) => dispatchSseFrame(frame, onEvent));
}

/**
 * Split the byte stream into SSE frames and pass each one on.
 *
 * A network chunk has no relationship to a frame boundary — one chunk can hold
 * three events or half of one — so bytes are buffered until a blank line shows up.
 * `decode(..., {stream:true})` matters for the same reason: a multi-byte character
 * can be split across two chunks.
 */
async function readSseFrames(body, onFrame) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffered.indexOf(SSE_FRAME_SEPARATOR)) >= 0) {
      onFrame(buffered.slice(0, boundary));
      buffered = buffered.slice(boundary + SSE_FRAME_SEPARATOR.length);
    }
  }

  /* A stream that ends without a trailing blank line still carries a real event —
     usually the `final` one — so the remainder must not be dropped. */
  if (buffered.trim()) onFrame(buffered);
}

/**
 * Parse one SSE frame ("event: stage\ndata: {...}") and emit it.
 * Follows the SSE wire format: `:` starts a comment, `data:` may repeat and the
 * parts are joined with newlines, and one optional space after the colon is part
 * of the syntax rather than of the value.
 */
function dispatchSseFrame(frame, onEvent) {
  let type = "message"; // the SSE default when a frame carries no `event:` line
  const dataLines = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, ""); // tolerate CRLF from an intermediary
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) type = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
  }
  if (!dataLines.length) return;

  const text = dataLines.join("\n");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    /* The backend sends JSON for every documented event, but a bare-text frame
       (a proxy keep-alive, a truncated payload) should still surface as a note
       rather than kill the reader loop. */
    data = { text };
  }
  onEvent(type, data);
}

/** How often the elapsed-time counters are repainted while a step is running. */
const TIMER_REPAINT_INTERVAL_MS = 120;

/** Guards the score-bar division when every item in a list scored zero. */
const MIN_SCORE_DENOMINATOR = 1e-9;

/** A bar this narrow still reads as "present but tiny" rather than as missing. */
const MIN_SCORE_BAR_PERCENT = 3;

/**
 * One step in the panel. Every step goes through this factory so that each field
 * exists from the start — `render` reads `detail`, `sub` and `ms` on steps that
 * may never receive them.
 */
function createStep({ key, id, icon, label, status, startedAt, detail = null }) {
  return {
    key,           // stable id for the DOM: `${stage id}-${position}`
    id,            // stage id from the spec (plan, search, facts, live, read, answer, verify)
    icon,
    label,
    status,        // "run" | "done" | "skip" | "fail"
    startedAt,     // performance.now() at creation, for the live counter
    ms: null,      // final duration: reported by the backend, else measured here
    detail: detail, // stage `detail` object, merged as further events arrive
    sub: null,     // secondary label shown only while the step is running
    calls: [],     // tool calls made inside this step
    notes: [],     // agent notes attached after this step
  };
}

/**
 * The panel itself: an append-only list of steps rendered from scratch on every
 * event. Re-rendering the whole panel is deliberate — a question produces a few
 * dozen events at most, and full re-render removes a whole class of bug where the
 * DOM and the step list drift apart.
 */
export class PipelinePanel {
  constructor(mount) {
    this.mount = mount;
    this.steps = [];
    this.prelude = [];        // notes that arrived before the first stage
    this.expanded = new Set(); // keys of tool calls whose result list is open
    this.collapsed = false;
    this.toolCalls = 0;
    this.startedAt = performance.now();
    this.finalSummary = null;
    this.receipt = null;        // the cost receipt, set by complete() from the final event
    this.receiptOpen = false;   // whether the itemised table under the summary is showing
    this.element = null;
    this.timerHandle = setInterval(() => this.paintTimers(), TIMER_REPAINT_INTERVAL_MS);
    this.render();
  }

  /** Stop the timer. Without this the interval outlives an abandoned panel forever. */
  destroy() {
    clearInterval(this.timerHandle);
  }

  /**
   * The single entry point for every stream event, so app.js does not need to know
   * the panel's internals. `final` is handled by the caller via `complete()`,
   * because it also drives the answer card, hence the render suppression here.
   */
  onEvent(type, payload = {}) {
    if (type === "stage") this.applyStage(payload);
    else if (type === "tool_call") this.applyToolCall(payload);
    else if (type === "tool_result") this.applyToolResult(payload);
    else if (type === "note") this.applyNote(payload);
    else if (type === "error") this.markFailed(payload.message || "stream error");
    if (type !== "final") this.render();
  }

  applyStage(payload) {
    if (payload.status === "start") this.startStage(payload);
    else this.endStage(payload);
  }

  /**
   * Only one step is ever "run" at a time, so a new stage closes whatever is still
   * open. The backend is allowed to skip a `done` (an aborted or crashed agent
   * loop), and without this the previous step would spin forever.
   */
  startStage(payload) {
    const display = this.displayFor(payload.id);
    this.closeRunningSteps();
    this.steps.push(createStep({
      key: `${payload.id}-${this.steps.length}`,
      id: payload.id,
      icon: display.icon,
      label: payload.label || display.label,
      status: "run",
      startedAt: performance.now(),
      detail: payload.detail || null,
    }));
  }

  /**
   * Close the matching running step. `search`, `facts`, `live` and `read` repeat
   * as the agent loops, so the match runs newest-first: an event must close the
   * latest occurrence of that stage, not the first one from an earlier iteration.
   */
  endStage(payload) {
    const step = this.findRunningStep(payload.id) || this.adoptOrphanStage(payload);
    step.status = payload.status === "skip" ? "skip" : "done";
    /* `ms === undefined` means the backend did not time it; measure locally. An
       explicit null is a deliberate "unknown" (the /ask replay path) and is kept. */
    step.ms = payload.ms === undefined ? Math.round(performance.now() - step.startedAt) : payload.ms;
    if (payload.label) step.label = payload.label;
    if (payload.detail) step.detail = { ...(step.detail || {}), ...payload.detail };
  }

  /** A `done`/`skip` with no preceding `start` — synthesise the step so it still shows. */
  adoptOrphanStage(payload) {
    const display = this.displayFor(payload.id);
    this.steps.push(createStep({
      key: `${payload.id}-${this.steps.length}`,
      id: payload.id,
      icon: display.icon,
      label: payload.label || display.label,
      status: "run",
      startedAt: performance.now(),
    }));
    return this.steps.at(-1);
  }

  displayFor(stageId) {
    return STAGE_DISPLAY[stageId] || { icon: "•", label: stageId };
  }

  findRunningStep(stageId) {
    return [...this.steps].reverse().find((step) => step.id === stageId && step.status === "run");
  }

  /**
   * The step a tool call belongs to. The agent is free to call a tool without
   * announcing a stage first, so a placeholder step is created rather than losing
   * the call — the panel must show every tool call, that is its whole point.
   */
  currentStep() {
    const open = [...this.steps].reverse().find((step) => step.status === "run");
    if (open) return open;
    this.steps.push(createStep({
      key: `tool-${this.steps.length}`,
      id: "search",
      icon: "⌕",
      label: "Working",
      status: "run",
      startedAt: performance.now(),
    }));
    return this.steps.at(-1);
  }

  applyToolCall(payload) {
    this.toolCalls++;
    const step = this.currentStep();
    step.calls.push({
      tool: payload.tool,
      args: payload.args || null,
      label: payload.label || "",
      startedAt: performance.now(),
      items: null,
      summary: null, // stays null until the result arrives; that is the "in flight" marker
      ms: null,
    });
    if (payload.label) step.sub = payload.label;
  }

  /**
   * Attach a result to the call it answers. Matching is by tool name, newest first,
   * and skips calls that already have a summary — the agent may call `search_corpus`
   * twice in one stage (a retry with a broader query), and results can only be
   * paired with requests by order, since the spec carries no correlation id.
   */
  applyToolResult(payload) {
    const step = this.currentStep();
    const call = [...step.calls].reverse().find((candidate) => candidate.tool === payload.tool && candidate.summary == null)
      || step.calls.at(-1);

    /* A result with no call at all (the /ask replay can emit one) still gets a row. */
    if (!call) {
      step.calls.push({
        tool: payload.tool,
        summary: payload.summary,
        ms: payload.ms,
        items: payload.items || null,
      });
      return;
    }

    call.summary = payload.summary ?? "";
    call.ms = payload.ms === undefined ? Math.round(performance.now() - call.startedAt) : payload.ms;
    call.items = payload.items || null;

    /* Auto-open a result that has something to show, so the evidence is on screen
       as it arrives rather than behind a click nobody makes during a demo. */
    if (call.items?.length || (payload.summary && payload.summary.length)) {
      this.expanded.add(expandKeyFor(step, step.calls.indexOf(call)));
    }
  }

  /** Notes explain a judgement call; before any stage exists they go in the prelude. */
  applyNote(payload) {
    if (!this.steps.length) {
      this.prelude.push(payload.text || "");
      return;
    }
    this.steps.at(-1).notes.push(payload.text || "");
  }

  markFailed(message) {
    this.closeRunningSteps("fail");
    this.steps.push(createStep({
      key: `err-${this.steps.length}`,
      id: "error",
      icon: "!",
      label: message,
      status: "fail",
      startedAt: performance.now(),
    }));
    this.steps.at(-1).ms = 0; // an error is instantaneous; showing a duration would be noise
  }

  closeRunningSteps(as = "done") {
    for (const step of this.steps) {
      if (step.status !== "run") continue;
      step.status = as;
      step.ms = Math.round(performance.now() - step.startedAt);
    }
  }

  /**
   * Called by app.js when the `final` event lands. The panel has done its job at
   * that point, so it collapses to one line and the answer card takes the space.
   * Trace latency is preferred over wall-clock, because it is the number the
   * backend measured and the same one shown on the answer card and in the eval.
   */
  complete(result) {
    this.closeRunningSteps();
    const totalMs = result?.trace?.latency_ms ?? Math.round(performance.now() - this.startedAt);

    const parts = [`${this.steps.length} step${this.steps.length === 1 ? "" : "s"}`];
    if (this.toolCalls) parts.push(`${this.toolCalls} tool call${this.toolCalls === 1 ? "" : "s"}`);
    parts.push(formatDuration(totalMs));
    if (result?.trace?.cost_usd != null) parts.push(formatUsd(result.trace.cost_usd));
    if (result?.trace?.model) parts.push(result.trace.model);

    this.finalSummary = parts.join("  ·  ");
    /* The receipt survives the panel collapsing: the step list is a live view that
       has done its job, but "what did that cost" is what a reader wants AFTER the
       answer is on screen, so it stays reachable behind one click. */
    this.receipt = result?.trace?.receipt ?? null;
    this.collapsed = true;
    clearInterval(this.timerHandle);
    this.timerHandle = null;
    this.render();
  }

  render() {
    this.mountOnce();
    this.element.classList.toggle("collapsed", this.collapsed);
    this.element.innerHTML = this.renderHeadHtml() + this.renderBodyHtml() + this.renderReceiptHtml();
  }

  /**
   * The receipt line under the pipeline summary, and the itemised table behind it.
   *
   * Rendered outside `.pipe-body` on purpose: the body is hidden when the panel
   * collapses, and the receipt must stay visible once the answer has arrived.
   *
   * The table markup is `window.__receiptRowsHtml`, defined in app.js, so the
   * receipt under an answer and the one in the Cost view are literally the same
   * rendering. The fallback keeps this module standalone (mock mode, and the unit
   * tests, which import it without app.js).
   */
  renderReceiptHtml() {
    const receipt = this.receipt;
    if (!receipt?.rows?.length) return "";
    const total = receipt.total;
    /* Spaces between thousands, not commas, matching every other figure in the app and in
       COST.md: the same number must not be spelled two ways on one screen. */
    const digits = (n) => n.toLocaleString("en-US").replace(/,/g, " ");
    const cached = total.cache_read ? ` (${digits(total.cache_read)} cached)` : "";
    const lead = `${receipt.rows.length} steps · ${digits(total.tokens_in)} tokens in${cached}`
      + ` · ${digits(total.tokens_out)} out · ${formatUsd(total.usd)} · ${formatDuration(total.wall_ms)}`;

    const table = typeof window !== "undefined" && window.__receiptRowsHtml
      ? window.__receiptRowsHtml(receipt)
      : "";

    return `<div class="pipe-receipt${this.receiptOpen ? " open" : ""}">
      <button class="rc-toggle" type="button">
        <span class="rc-lead">receipt</span>
        <span>${escapeHtml(lead)}</span>
        <span class="rc-more">${this.receiptOpen ? "hide ▴" : "itemise ▾"}</span>
      </button>
      ${this.receiptOpen ? `<div class="receipt">${table}</div>` : ""}
    </div>`;
  }

  /**
   * Create the panel element and attach its click handler exactly once.
   * The handler is delegated from the panel root on purpose: `render()` replaces
   * all inner HTML on every event, so a listener bound to a button would be thrown
   * away microseconds later.
   */
  mountOnce() {
    if (this.element) return;
    this.element = document.createElement("section");
    this.element.className = "pipe";
    this.mount.appendChild(this.element);
    this.element.addEventListener("click", (event) => {
      const target = event.target.closest(".pipe-toggle, .expand, .rc-toggle");
      if (!target) return;
      if (target.classList.contains("rc-toggle")) {
        this.receiptOpen = !this.receiptOpen;
      } else if (target.classList.contains("pipe-toggle")) {
        this.collapsed = !this.collapsed;
      } else {
        const key = target.dataset.k;
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
      }
      this.render();
    });
  }

  renderHeadHtml() {
    const running = this.steps.some((step) => step.status === "run");
    /* While running there is no final summary yet, so the slot holds a live clock;
       `js-elapsed` is the hook paintTimers() writes into between renders. */
    const summary = this.finalSummary
      ? escapeHtml(this.finalSummary)
      : `<span class="js-elapsed">${formatDuration(performance.now() - this.startedAt)}</span>`;

    return `
      <div class="pipe-head">
        <span class="pipe-title">${running ? "pipeline · live" : "pipeline"}</span>
        <span class="pipe-sum">${summary}</span>
        <button class="pipe-toggle" type="button">${this.collapsed ? "expand ▾" : "collapse ▴"}</button>
      </div>`;
  }

  renderBodyHtml() {
    const prelude = this.prelude
      .map((note) => `<div class="note" style="margin-left:0">${escapeHtml(note)}</div>`)
      .join("");
    /* The placeholder covers the gap between "Ask" being pressed and the first
       stage event, which on a cold model call can be a second or more of silence. */
    const placeholder = '<div class="step run"><span class="ic">◇</span>'
      + '<span class="lbl">Starting…</span><span class="ms"></span></div>';
    const steps = this.steps.map((step) => this.renderStepHtml(step)).join("") || placeholder;
    return `<div class="pipe-body">${prelude}${steps}</div>`;
  }

  /**
   * Update the running counters in place, without a full render. Re-rendering ten
   * times a second would reset the CSS pulse animation and drop text selection.
   */
  paintTimers() {
    if (!this.element) return;
    const elapsed = this.element.querySelector(".js-elapsed");
    if (elapsed) elapsed.textContent = formatDuration(performance.now() - this.startedAt);
    for (const step of this.steps) {
      if (step.status !== "run") continue;
      const cell = this.element.querySelector(`[data-ms="${step.key}"]`);
      if (cell) cell.textContent = formatDuration(performance.now() - step.startedAt);
    }
  }

  renderStepHtml(step) {
    const statusClass = STEP_STATUS_CLASS[step.status] || "done";
    /* A finished step trades its stage icon for a tick, which is what makes the
       list read as progress rather than as a static agenda. */
    let icon = step.icon;
    if (step.status === "done") icon = "✓";
    else if (step.status === "skip") icon = "–";

    let timing;
    if (step.status === "run") {
      timing = `<span data-ms="${step.key}">${formatDuration(performance.now() - step.startedAt)}</span>`;
    } else if (step.status === "skip") {
      timing = "skipped";
    } else {
      timing = formatDuration(step.ms);
    }

    const sub = step.status === "run" && step.sub ? `<span class="sub">${escapeHtml(step.sub)}</span>` : "";
    const calls = step.calls.map((call, index) => this.renderCallHtml(step, call, index)).join("");
    const stageDetail = step.detail ? this.renderDetailHtml(step.detail, step.calls.length > 0) : "";
    const notes = step.notes.map((note) => `<div class="note">${escapeHtml(note)}</div>`).join("");

    /* Notes are siblings of the step, not children: they sit between steps in the
       vertical rail, which is how the spec describes them. */
    return `<div class="step ${statusClass}">
      <span class="ic">${icon}</span>
      <span class="lbl"><b>${escapeHtml(step.label)}</b>${sub}</span>
      <span class="ms">${timing}</span>
      ${calls || stageDetail ? `<div class="det">${calls}${stageDetail}</div>` : ""}
    </div>${notes}`;
  }

  /** One tool call: the invocation line, plus its result list behind a toggle. */
  renderCallHtml(step, call, index) {
    const expandKey = expandKeyFor(step, index);
    const isOpen = this.expanded.has(expandKey);

    /* Empty and null args are dropped so the line shows what the agent actually
       chose, not the full schema with a row of blanks. */
    const args = call.args
      ? Object.entries(call.args)
          .filter(([, value]) => value != null && value !== "")
          .map(([name, value]) =>
            `<b>${escapeHtml(name)}</b>=${escapeHtml(Array.isArray(value) ? value.join(",") : value)}`)
          .join("  ")
      : "";

    /* A null summary means the result has not arrived; the spinner is the only
       thing distinguishing an in-flight call from one that returned nothing. */
    const outcome = call.summary != null
      ? `  →  ${escapeHtml(call.summary)}`
      : ' <span class="spin"></span>';
    const timing = call.ms != null ? `  <span style="opacity:.7">${formatDuration(call.ms)}</span>` : "";

    const head = `<div class="args">`
      + `<span style="color:var(--accent)">${TOOL_ICONS[call.tool] || "▸"}</span> `
      + `<b>${escapeHtml(call.tool)}</b>${args ? "  " + args : ""}${outcome}${timing}`
      + `</div>`;

    const hasItems = !!(call.items && call.items.length);
    const toggle = hasItems
      ? `<button class="expand" type="button" data-k="${expandKey}">`
        + `${isOpen ? "hide" : "show"} ${call.items.length} result${call.items.length === 1 ? "" : "s"}`
        + `</button>`
      : "";

    return head + toggle + (isOpen && hasItems ? this.renderItemsHtml(call.items) : "");
  }

  /**
   * Render a stage's `detail` object — the spec leaves its shape open, so this
   * handles the three shapes the backend actually sends: a plain string, a list of
   * items, or a flat bag of scalars (model, tokens, gate verdicts).
   */
  renderDetailHtml(detail, hasCalls = false) {
    if (typeof detail === "string") return `<div class="args">${escapeHtml(detail)}</div>`;
    if (Array.isArray(detail.items)) return this.renderItemsHtml(detail.items);

    /* When the stage already printed a tool line, these keys would repeat it. */
    const alreadyShownOnToolLine = hasCalls ? ["tool", "summary", "args", "label", "query"] : [];
    const rows = Object.entries(detail).filter(([key, value]) =>
      !alreadyShownOnToolLine.includes(key)
      /* Nested objects have no sensible one-line rendering, so they are dropped
         rather than printed as "[object Object]". */
      && (typeof value !== "object" || value == null));
    if (!rows.length) return "";

    return `<div class="args">${rows
      .map(([name, value]) => `<b>${escapeHtml(name)}</b>=${escapeHtml(value)}`)
      .join("  ")}</div>`;
  }

  /**
   * Tool results arrive as two different row shapes and the spec does not label
   * which: fact-ledger rows carry key/value, retrieval hits carry title/url/score.
   * Sniffing the payload keeps one call site instead of branching per tool name.
   */
  renderItemsHtml(items) {
    const isFactLedger = items.some((item) => item.key != null && item.value != null);
    if (isFactLedger) return renderFactRowsHtml(items);
    return renderSearchHitsHtml(items);
  }
}

/* CSS class per step status; `fail` and `skip` are styled differently in styles.css. */
const STEP_STATUS_CLASS = { run: "run", skip: "skip", fail: "fail", done: "done" };

/** Identifies one tool call for the expand/collapse set, stable across re-renders. */
function expandKeyFor(step, callIndex) {
  return step.key + "|" + callIndex;
}

/** Fact-ledger rows: what the value was, when it was true, and who said so. */
function renderFactRowsHtml(rows) {
  return `<div class="hitlist">${rows.map((fact) => `<div class="factrow">
        <span><code>${escapeHtml(fact.key)}</code> <span class="fv">${escapeHtml(fact.value)}</span></span>
        <span class="dim mono" style="font-size:11px">${escapeHtml(fact.as_of || "undated")}</span>
        <span class="dim mono" style="font-size:11px">${escapeHtml(fact.domain || domainFromUrl(fact.url))}</span>
      </div>`).join("")}</div>`;
}

/**
 * Retrieval hits with a relative score bar. Score and date columns are dropped
 * wholesale when no row has them (a `get_document` result, say) — the extra
 * classes let styles.css reclaim the width instead of leaving empty columns.
 */
function renderSearchHitsHtml(hits) {
  const hasScores = hits.some((hit) => Number(hit.score) > 0);
  const hasDates = hits.some((hit) => hit.date || hit.published_at);
  /* Bars are relative to the best hit in this list, because absolute hybrid-search
     scores are tiny (~0.01) and mean nothing on their own. */
  const bestScore = Math.max(...hits.map((hit) => Number(hit.score) || 0), MIN_SCORE_DENOMINATOR);
  const rowClass = "hit" + (hasScores ? "" : " noscore") + (hasDates ? "" : " nodate");

  return `<div class="hitlist">${hits.map((hit) => {
    const barPercent = Math.max(
      MIN_SCORE_BAR_PERCENT,
      Math.round(100 * (Number(hit.score) || 0) / bestScore),
    );
    return `<div class="${rowClass}">
      <span class="hn">${hit.n != null ? "[" + hit.n + "]" : ""}</span>
      <span class="ht" title="${escapeHtml(hit.title || hit.url)}">${escapeHtml(hit.title || domainFromUrl(hit.url))} <span class="dim">· ${escapeHtml(hit.domain || domainFromUrl(hit.url))}</span></span>
      ${hasDates ? `<span class="hd">${escapeHtml(hit.date || hit.published_at || "undated")}</span>` : ""}
      ${hasScores ? `<span class="hb" title="score ${escapeHtml(hit.score ?? "")}"><i style="width:${barPercent}%"></i></span>` : ""}
    </div>`;
  }).join("")}</div>`;
}
