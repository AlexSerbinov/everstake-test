/**
 * Everstake KB — the UI shell.
 *
 * Where this sits in the system: the last stage of the pipeline
 * (crawl → dedup → index → facts → retrieve → answer → eval). It renders what the
 * backend decided; it never decides anything about evidence itself. Every number,
 * date, gate verdict and citation on screen comes from the API — if this file
 * invented one, the whole "evidence-first" claim of the project would be false.
 *
 * There is no build step: the browser loads this as an ES module directly, so
 * everything here must be plain, current browser JavaScript with no imports beyond
 * the two sibling modules.
 *
 * Responsibilities:
 *   - the Ask view: stream POST /ask/stream, render the answer, sources and trace;
 *   - the Explore views (facts, corpus, instructions, eval, settings), each a thin
 *     renderer over one /api/… endpoint, loaded lazily on first visit;
 *   - the document modal, shared by every view.
 *
 * The DOM ids and CSS class names used below are defined in index.html and
 * styles.css. They are a contract with those two files: renaming one here without
 * renaming it there produces a silently blank panel, not an error.
 */

import { PipelinePanel, streamAsk, escapeHtml, domainFromUrl, formatDuration, formatUsd }
  from "./pipeline.js";
import { replayMockStream, isMockModeEnabled } from "./mock-stream.js";

/* `$`/`$$` are kept short on purpose: they are the universally recognised
   querySelector idiom and appear on almost every line that touches the DOM. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* The two answer endpoints. `/ask/stream` is the live path; `/ask` is the same
   pipeline without streaming and is the fallback. See docs/agentic-spec.md. */
const ASK_STREAM_PATH = "/ask/stream";
const ASK_PATH = "/ask";

/**
 * Every API call in this file goes through here, so error handling is uniform.
 * The server reports failures as `{error: "..."}` with a non-2xx status; that
 * message is far more useful than "500", which is why it is preferred over
 * `statusText`. The inner catch covers a body that is not JSON at all (a proxy
 * error page), where reading `.error` would otherwise throw over the real problem.
 */
const fetchJson = async (path, options) => {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || response.statusText);
  }
  return response.json();
};

/** Source tier: 1 = first-party, 2 = press, 3 = video/social. Coloured in styles.css. */
const tierBadgeHtml = (tier) => `<span class="tier t${tier}">T${tier}</span>`;

/** Confidence and accuracy arrive as 0..1 fractions; nobody reads those out loud. */
const formatPercent = (fraction) => Math.round((fraction || 0) * 100) + "%";

/* ---------------------------------------------------------------------------
   Theme
   --------------------------------------------------------------------------- */

/* Key in localStorage. Shared with nothing else, but it must stay stable or a
   returning user silently loses their choice. */
const THEME_STORAGE_KEY = "theme";
const documentRoot = document.documentElement;

/**
 * Restore the saved theme, otherwise follow the OS. Every localStorage access in
 * this file is wrapped: in a private window or with site data blocked, reading it
 * throws, and an unstyled page is a worse failure than an unremembered theme.
 */
function applyInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) documentRoot.dataset.theme = saved;
  } catch {}
  if (!documentRoot.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) {
    documentRoot.dataset.theme = "dark";
  }
}
applyInitialTheme();

$("#theme").onclick = () => {
  documentRoot.dataset.theme = documentRoot.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, documentRoot.dataset.theme);
  } catch {}
};

/* ---------------------------------------------------------------------------
   Demo mode
   --------------------------------------------------------------------------- */

/* `?mock=1` replays a scripted stream entirely in the browser (mock-stream.js), so
   the UI can be demonstrated with no backend, no API keys and no database. The
   corner flag exists so nobody in the room mistakes a replay for a live answer. */
const IS_MOCK_MODE = isMockModeEnabled();
if (IS_MOCK_MODE) {
  const flag = document.createElement("div");
  flag.className = "mockflag";
  flag.textContent = "demo mode · replayed stream";
  document.body.appendChild(flag);
}

/* ---------------------------------------------------------------------------
   Views and the Explore menu
   --------------------------------------------------------------------------- */

/* Which views have already fetched their data. Views are loaded on first visit
   rather than at startup, because each one costs an API round trip and most
   sessions only ever use Ask. */
const loadedViews = {};

/* View name → loader. The keys double as the URL hash and as the `data-view`
   attribute on the Explore menu buttons in index.html; "ask" is deliberately
   absent, since it needs no loading and is the default. */
const VIEW_LOADERS = {
  facts: loadFacts,
  corpus: loadCorpus,
  instructions: loadInstructions,
  eval: loadEval,
  cost: loadCost,
  settings: loadSettings,
};

function showView(name) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === "view-" + name));
  closeMenu();
  /* Views swap in place, so without this a user who had scrolled down lands
     mid-page in the new view. "instant" is feature-detected because Safari
     shipped scroll-behavior later than the other engines. */
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  /* Ask is the default view and gets a clean URL, so a shared link opens on the
     question box rather than on whichever panel was last inspected. */
  location.hash = name === "ask" ? "" : name;

  if (name !== "ask" && !loadedViews[name]) {
    loadedViews[name] = true;
    VIEW_LOADERS[name]?.();
  }
  /* The input is hidden while another view is active, and focusing a hidden
     element does nothing — hence the wait for the class swap to take effect. */
  if (name === "ask") setTimeout(() => $("#q").focus(), FOCUS_AFTER_VIEW_SWAP_MS);
}

/** Long enough for the .view class swap to paint before the input is focused. */
const FOCUS_AFTER_VIEW_SWAP_MS = 60;

const menu = $("#exploreMenu");
const menuButton = $("#exploreBtn");
const openMenu = () => {
  menu.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
};
const closeMenu = () => {
  menu.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
};

menuButton.onclick = (event) => {
  /* Without this the click also reaches the document handler below, which would
     close the menu in the same tick it was opened. */
  event.stopPropagation();
  if (menu.hidden) openMenu();
  else closeMenu();
};
menu.onclick = (event) => {
  const button = event.target.closest("button");
  if (button) showView(button.dataset.view);
};
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeMenu();
});
$("#homeBtn").onclick = () => showView("ask");

/** Keep the visible view in step with the URL, for Back/Forward and pasted links. */
function showViewFromHash() {
  const name = location.hash.slice(1);
  const target = VIEW_LOADERS[name] ? name : "ask";
  /* The guard matters: showView() rewrites location.hash, so calling it for the
     view that is already active would loop through hashchange. */
  if (!$("#view-" + target).classList.contains("active")) showView(target);
}
addEventListener("hashchange", showViewFromHash);
if (location.hash.length > 1 && VIEW_LOADERS[location.hash.slice(1)]) {
  showView(location.hash.slice(1));
}

/* ---------------------------------------------------------------------------
   Keyboard shortcuts
   --------------------------------------------------------------------------- */

document.addEventListener("keydown", (event) => {
  const isTypingInAField = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);

  /* "/" jumps to the question box from anywhere — the shortcut advertised by the
     <kbd> hint in the hero. Suppressed while typing, or it would be impossible to
     type a slash into a URL filter. preventDefault stops Firefox's quick-find. */
  if (event.key === "/" && !isTypingInAField) {
    event.preventDefault();
    showView("ask");
    $("#q").focus();
    $("#q").select();
  }

  /* Escape unwinds one layer at a time, innermost first, so it never skips past
     something the user is looking at. Each branch returns for that reason. */
  if (event.key === "Escape") {
    if (!$("#docModal").hidden) { $("#docModal").hidden = true; return; }
    if (!menu.hidden) { closeMenu(); return; }
    if (!$("#view-ask").classList.contains("active")) { showView("ask"); return; }
    if (isTypingInAField) event.target.blur();
  }
});

/* ---------------------------------------------------------------------------
   Header strip
   --------------------------------------------------------------------------- */

/**
 * The one-line "which model, how much corpus" strip in the header. `resolved_answer`
 * is preferred over `answer` because the config may hold an alias (e.g. "fast")
 * while the strip should name the model that actually runs.
 */
fetchJson("/api/stats").then((stats) => {
  const model = stats.models.resolved_answer || stats.models.answer;
  $("#provider").textContent =
    `${model} · ${stats.documents.canonical} docs · ${stats.chunks.total} chunks`;
}).catch(() => {
  /* In demo mode there is no API by design, so "offline" would be misleading. */
  $("#provider").textContent = IS_MOCK_MODE ? "demo data" : "api offline";
});

/* ---------------------------------------------------------------------------
   Ask
   --------------------------------------------------------------------------- */

const hero = $("#hero");
const results = $("#results");

/** The panel for the question currently on screen; replaced on every new question. */
let pipeline = null;
/** AbortController of the request in flight, so a second question cancels the first. */
let inflight = null;

$("#examples").onclick = (event) => {
  const chip = event.target.closest("button");
  if (!chip) return;
  $("#q").value = chip.textContent;
  /* requestSubmit rather than submit() so the form's own submit handler runs. */
  $("#askForm").requestSubmit();
};

$("#newQ").onclick = () => {
  inflight?.abort();
  results.hidden = true;
  hero.classList.remove("gone");
  $("#q").value = "";
  $("#q").focus();
};

$("#askForm").onsubmit = (event) => {
  event.preventDefault();
  ask($("#q").value.trim());
};

/**
 * Ask a question and drive the whole result area from the answer stream.
 *
 * Two paths, one renderer: the live SSE stream, and — if the stream cannot be
 * opened or dies mid-flight — the plain POST /ask endpoint whose recorded steps
 * are replayed into the same panel. A reviewer must see the same trace either way,
 * otherwise the pipeline view stops being evidence of what happened.
 */
async function ask(question) {
  if (!question) return;
  /* A second question supersedes the first: without the abort the old stream
     keeps writing into the panel that now belongs to the new question. */
  inflight?.abort();
  const abortController = new AbortController();
  inflight = abortController;

  prepareResultArea(question);
  setAskButtonBusy(true);

  /* Event names below are the SSE contract from docs/agentic-spec.md. `final` is
     handled here rather than inside the panel because it also produces the answer
     card; every other event belongs to the panel alone. */
  let sawFinalEvent = false;
  const onEvent = (type, data) => {
    if (type === "final") {
      sawFinalEvent = true;
      pipeline.complete(data);
      renderResult(data);
    } else {
      pipeline.onEvent(type, data);
    }
  };

  try {
    if (IS_MOCK_MODE) await replayMockStream(question, onEvent, abortController.signal);
    else await streamAsk(ASK_STREAM_PATH, question, onEvent, abortController.signal);
    /* A stream that closes cleanly but never sent `final` is a backend crash
       mid-answer. Treated as a stream failure so the fallback still runs. */
    if (!sawFinalEvent) throw new Error("stream ended without a final answer");
  } catch (streamError) {
    if (abortController.signal.aborted) {
      setAskButtonBusy(false);
      return;
    }
    await answerWithoutStreaming(question, streamError, abortController.signal);
  }
  setAskButtonBusy(false);
}

/** Clear the previous answer and put a fresh, empty pipeline panel on screen. */
function prepareResultArea(question) {
  hero.classList.add("gone");
  results.hidden = false;
  $("#askedText").textContent = question;
  $("#answerSlot").innerHTML = "";
  $("#traceSlot").innerHTML = "";
  $("#sources").innerHTML =
    `<div class="side-empty">Sources appear here as the pipeline finds them.</div>`;
  $("#sideHead").hidden = true;
  $("#srcCount").textContent = "";

  /* destroy() stops the previous panel's repaint interval. Skipping it leaks one
     timer per question for the lifetime of the tab. */
  pipeline?.destroy();
  $("#pipelineSlot").innerHTML = "";
  pipeline = new PipelinePanel($("#pipelineSlot"));
}

function setAskButtonBusy(busy) {
  const button = $("#askBtn");
  button.disabled = busy;
  if (busy) button.innerHTML = '<span class="spin"></span>asking';
  else button.textContent = "Ask";
}

/**
 * Fallback when the stream is unavailable. The note is written into the panel
 * rather than swallowed, because "why does this look different from the demo" is
 * exactly the question a reviewer asks, and the honest answer belongs on screen.
 */
async function answerWithoutStreaming(question, streamError, signal) {
  pipeline.onEvent("note", {
    text: `Live stream unavailable (${streamError.message}). Falling back to POST /ask`
      + ` — same pipeline, reported after the fact.`,
  });
  try {
    const result = await fetchJson(ASK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
      signal,
    });
    replayStepsIntoPipeline(result);
    pipeline.complete(result);
    renderResult(result);
  } catch (fallbackError) {
    if (signal.aborted) return;
    pipeline.onEvent("error", { message: fallbackError.message });
    pipeline.complete(null);
    renderError(fallbackError.message);
  }
}

/* ---------------------------------------------------------------------------
   Replaying a non-streamed result into the pipeline panel
   --------------------------------------------------------------------------- */

/**
 * Turn a finished /ask result back into the event sequence the panel expects, so
 * the fallback path produces the same trace as the live one.
 *
 * Two shapes are handled because the backend has had two: `steps[]` as recorded by
 * the agent loop (docs/agentic-spec.md), and older results that carry only a
 * `trace` object. The second branch is what makes an old row in `questions_log`
 * still renderable.
 */
function replayStepsIntoPipeline(result) {
  const steps = Array.isArray(result?.steps) ? result.steps
    : Array.isArray(result?.trace?.steps) ? result.trace.steps
    : null;

  if (steps?.length) {
    for (const step of steps) replayRecordedStep(step);
    return;
  }
  synthesiseClassicTrace(result);
}

/** Emit the stage/tool events for one recorded step. */
function replayRecordedStep(step) {
  if (step.type === "note" || step.text) {
    pipeline.onEvent("note", { text: step.text });
    return;
  }

  if (step.tool) {
    /* A recorded tool call carries no stage of its own in the older format, so it
       is attributed to `search` — the stage that owns most tool calls. */
    const stageId = step.stage || "search";
    pipeline.onEvent("stage", { id: stageId, label: step.label, status: "start" });
    pipeline.onEvent("tool_call", { tool: step.tool, args: step.args, label: step.label });
    pipeline.onEvent("tool_result", {
      tool: step.tool,
      summary: step.summary,
      ms: step.ms,
      items: step.items,
    });
    pipeline.onEvent("stage", { id: stageId, status: "done", ms: step.ms });
    return;
  }

  const stageId = step.id || step.stage || "plan";
  pipeline.onEvent("stage", { id: stageId, label: step.label, status: "start" });
  pipeline.onEvent("stage", {
    id: stageId,
    status: step.status === "skip" ? "skip" : "done",
    ms: step.ms,
    detail: step.detail,
  });
}

/**
 * Rebuild the classic retrieve → facts → answer → gate trace from a result that
 * predates `steps[]`. Durations are sent as an explicit null: these stages really
 * did happen, but nobody timed them, and inventing a wall-clock number here would
 * put a figure on screen that no measurement supports.
 */
function synthesiseClassicTrace(result) {
  const trace = result?.trace || {};

  pipeline.onEvent("stage", {
    id: "search",
    label: "Hybrid retrieval (BM25 + vector)",
    status: "start",
  });
  pipeline.onEvent("tool_call", {
    tool: "search_corpus",
    args: { query: trace.fts_query, vector: trace.vector_used ? "on" : "off" },
    label: "search_corpus",
  });
  pipeline.onEvent("tool_result", {
    tool: "search_corpus",
    ms: null,
    summary: `${trace.candidates?.length || 0} candidates,`
      + ` ${trace.selected?.length || 0} to the model`,
    items: (result.sources || []).map((source) => ({
      n: source.n,
      title: source.title,
      url: source.url,
      domain: source.domain,
      date: source.effective_date || source.published_at,
      score: source.score,
    })),
  });
  pipeline.onEvent("stage", { id: "search", status: "done", ms: null });

  if (trace.facts?.length) {
    pipeline.onEvent("stage", { id: "facts", label: "Reading the fact ledger", status: "start" });
    pipeline.onEvent("tool_call", {
      tool: "fact_history",
      /* The ledger is queried per key; the same key repeats across rows, so the
         de-duplicated set is what the call actually asked for. */
      args: { keys: [...new Set(trace.facts.map((fact) => fact.key))].join(",") },
      label: "fact_history",
    });
    pipeline.onEvent("tool_result", {
      tool: "fact_history",
      ms: null,
      summary: `${trace.facts.length} rows`,
      items: trace.facts.map((fact) => ({
        key: fact.key,
        value: fact.value,
        as_of: fact.as_of,
        url: fact.url,
      })),
    });
    pipeline.onEvent("stage", { id: "facts", status: "done", ms: null });
  }

  /* No model in the trace means the retrieval gate stopped the run before the
     model was ever asked — the stage is shown as skipped, not as failed. */
  pipeline.onEvent("stage", {
    id: "answer",
    label: "Drafting the answer",
    status: trace.model ? "start" : "skip",
    ms: 0,
  });
  if (trace.model) {
    pipeline.onEvent("stage", {
      id: "answer",
      status: "done",
      ms: trace.latency_ms,
      detail: {
        model: trace.model,
        tokens_in: trace.usage?.input,
        tokens_out: trace.usage?.output,
      },
    });
  }

  pipeline.onEvent("stage", { id: "verify", label: "Checking the gates", status: "start" });
  pipeline.onEvent("stage", {
    id: "verify",
    status: "done",
    ms: null,
    detail: {
      gate: result.gate,
      cited: (result.sources || []).map((source) => source.n).join(", ") || "none",
    },
  });
}

/* ---------------------------------------------------------------------------
   The answer
   --------------------------------------------------------------------------- */

/**
 * What each refusal means, in the operator's words, and what to do about it.
 *
 * The keys are the `gate` values the backend sets (docs/agentic-spec.md
 * § Guarantees); adding a gate there without adding it here silently falls back to
 * `none`. This table exists because "I don't know" is a graded feature of the
 * system, not an error state: a refusal has to explain which check refused and
 * leave the user a way forward, or it reads as a broken app.
 */
const GATE_EXPLANATIONS = {
  gate1_no_evidence: {
    title: "Nothing in the corpus supports an answer",
    what: "Gate 1 — retrieval floor. The best-scoring chunk stayed under the minimum score, so the model was never asked. Nothing was generated, so nothing could be invented.",
    tries: [["Rephrase", "Use the words the site itself uses — “validator”, “delegators”, “networks supported”."],
            ["Widen the corpus", "Settings → Filters: clear the excluded domains or the minimum year."],
            ["Lower the floor", "Settings → Gates: reduce “min best score”, then ask again and compare the trace."]],
  },
  gate2_no_valid_citations: {
    title: "The answer could not be tied to a source",
    what: "Gate 2 — citation check. The model produced text, but its citations did not point at sources actually handed to it. The text was discarded rather than shown.",
    tries: [["Ask something narrower", "One fact at a time cites more cleanly than a broad question."],
            ["More chunks", "Settings → Retrieval: raise “chunks to the model”."],
            ["Inspect the trace", "The candidate table below shows what the retriever did offer."]],
  },
  gate3_ungrounded_number: {
    title: "A number in the answer had no source",
    what: "Gate 3 — number grounding. Every numeric value in an answer must appear in a source or fact row the tools actually returned. The model wrote a figure that did not, so the answer was withheld rather than shown.",
    tries: [["Ask for the figure directly", "“How many delegators does Everstake report?” gives the ledger a clean target."],
            ["Check the ledger", "Explore → Facts timeline shows every recorded value with its source."],
            ["Relax the gate", "Settings → Gates: turn off “require grounded numbers” to see what the model wanted to say — for inspection only."]],
  },
  model_abstained: {
    title: "The model declined to answer",
    what: "The sources reached the model, but it judged them insufficient and abstained instead of guessing. That is the intended behaviour.",
    tries: [["Check the timeframe", "The corpus may simply predate what you are asking about."],
            ["Try the fact timeline", "Explore → Facts timeline shows every recorded value of a tracked key."],
            ["Rephrase", "A different wording retrieves a different neighbourhood of the corpus."]],
  },
  model_error: {
    title: "The provider call failed",
    what: "The answer model returned an error, so no answer was produced. This is infrastructure, not evidence — the corpus may well contain the answer.",
    tries: [["Ask again", "Transient provider errors usually clear on a retry."],
            ["Switch model", "Settings → Gates & model: pick another answer model."]],
  },
  none: { title: "No reliable answer", what: "The pipeline finished without a supported answer.", tries: [["Rephrase", "Try the wording the source pages use."]] },
};

/** Positions in a gate's `tries` list whose button jumps to the operator panel. */
const TRY_POSITIONS_LINKING_TO_SETTINGS = [1, 2];

function renderResult(result) {
  if (!result) return;
  const isAnswered = result.status === "answered";
  $("#answerSlot").innerHTML = isAnswered ? answeredCardHtml(result) : noAnswerCardHtml(result);
  renderSources(result.sources || []);
  renderTrace(result);
  wireCitationClicks();
  wireTryButtons(result);
}

/** The "what to try" buttons either open a view or refill the question box. */
function wireTryButtons(result) {
  $$(".try-list button", $("#answerSlot")).forEach((button) => {
    button.onclick = () => {
      if (button.dataset.view) {
        showView(button.dataset.view);
        return;
      }
      $("#q").value = result.question || "";
      showView("ask");
      $("#q").focus();
    };
  });
}

/**
 * The answered card. The meta row is the honesty strip: an explicit as-of date
 * (or an explicit "undated" — never a blank that could pass for "current"),
 * the confidence, and the measured cost and latency of this very call.
 */
function answeredCardHtml(result) {
  const meta = [
    `<span class="badge ok"><span class="dot"></span>answered</span>`,
    result.as_of
      ? `<span class="pill key">as of ${escapeHtml(result.as_of)}</span>`
      : `<span class="pill quiet">undated</span>`,
    result.mode ? `<span class="pill">${escapeHtml(result.mode)}</span>` : "",
    `<span class="pill">confidence ${formatPercent(result.confidence)}</span>`,
    `<span class="pill quiet">${formatUsd(result.trace?.cost_usd)} · ${formatDuration(result.trace?.latency_ms)}</span>`,
    result.trace?.model ? `<span class="pill quiet">${escapeHtml(result.trace.model)}</span>` : "",
  ].filter(Boolean).join("");

  return `<article class="answer-card"><div class="strip"></div><div class="answer-body">
    <div class="answer-meta">${meta}</div>
    <div class="answer-text">${linkifyCitationMarkers(result.answer)}</div>
  </div></article>`;
}

/**
 * The refusal card. It shows which gate fired, what the model did say (when it
 * said anything), and an explicit statement of what was NOT done — the promise
 * that a refusal is a refusal, not a quietly weakened answer.
 */
function noAnswerCardHtml(result) {
  const gate = GATE_EXPLANATIONS[result.gate] || GATE_EXPLANATIONS.none;
  const meta = [
    `<span class="badge idk"><span class="dot"></span>no reliable answer</span>`,
    `<span class="pill key">gate: ${escapeHtml(result.gate || "none")}</span>`,
    result.mode ? `<span class="pill">${escapeHtml(result.mode)}</span>` : "",
    `<span class="pill quiet">${formatUsd(result.trace?.cost_usd)} · ${formatDuration(result.trace?.latency_ms)}</span>`,
  ].join("");

  /* Which tips open Settings is decided by position, not by reading the tip text;
     a tip at any other position falls through to "re-ask this question". */
  const tries = gate.tries.map(([label, tip], position) => {
    const viewAttribute = TRY_POSITIONS_LINKING_TO_SETTINGS.includes(position)
      ? 'data-view="settings"'
      : "";
    return `<button type="button" ${viewAttribute}>`
      + `<span class="k">${escapeHtml(label)}</span>${escapeHtml(tip)}</button>`;
  }).join("");

  return `<article class="answer-card is-idk"><div class="strip"></div><div class="idk-panel">
    <div class="answer-meta">${meta}</div>
    <h3 class="idk-title">${escapeHtml(gate.title)}</h3>
    ${result.answer ? `<div class="idk-said">${escapeHtml(result.answer)}</div>` : ""}
    <div class="gate-box">
      <span class="gk">why</span><span class="gv">${escapeHtml(gate.what)}</span>
      <span class="gk">not</span><span class="gv">No answer was fabricated, and no source was cited that did not exist.</span>
    </div>
    <div class="try-list"><span class="tl-h">what to try</span>
      ${tries}
    </div>
  </div></article>`;
}

/**
 * Transport failure, which is a different thing from a refusal: nothing was
 * judged, so the card explicitly says the corpus was never consulted. Conflating
 * the two would make the system look like it refuses whenever the network hiccups.
 */
function renderError(message) {
  $("#answerSlot").innerHTML = `<article class="answer-card is-err"><div class="strip"></div><div class="idk-panel">
    <div class="answer-meta"><span class="badge err"><span class="dot"></span>request failed</span></div>
    <h3 class="idk-title">The request did not complete</h3>
    <div class="gate-box"><span class="gk">error</span><span class="gv">${escapeHtml(message)}</span>
    <span class="gk">note</span><span class="gv">Neither the stream nor the plain endpoint answered. This says nothing about the corpus.</span></div>
  </div></article>`;
}

/**
 * Turn the "[3]" and "[3, 7]" markers the model writes into clickable chips that
 * scroll to the matching source card.
 *
 * The regex matches a bracketed list of digits with optional spaces —
 * "[3]", "[3,7]", "[3, 7, 13]" — and nothing else, so "[sic]" or an ordinary
 * bracket in a quote is left alone. Escaping happens BEFORE the replace: the
 * markers are the only markup this function is allowed to introduce.
 */
const linkifyCitationMarkers = (answerText) =>
  escapeHtml(answerText).replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_marker, list) =>
    list.split(/\s*,\s*/)
      .map((number) => `<span class="cite" data-n="${number}">${number}</span>`)
      .join(""));

/** Cards fade in one after another rather than all at once; 35 ms reads as a sweep. */
const SOURCE_CARD_STAGGER_MS = 35;

function renderSources(sources) {
  $("#sideHead").hidden = false;
  $("#srcCount").textContent = sources.length ? `${sources.length} cited` : "none";

  if (!sources.length) {
    $("#sources").innerHTML =
      `<div class="side-empty">Nothing was cited — no source cleared the evidence bar.</div>`;
    return;
  }
  $("#sources").innerHTML = sources.map(sourceCardHtml).join("");
}

/**
 * One source card. The id `src-<n>` is the anchor the citation chips scroll to, so
 * it has to match the `[n]` the model wrote, not the array position.
 */
function sourceCardHtml(source, position) {
  return `
    <article class="source t${source.tier}" id="src-${source.n}" style="animation-delay:${position * SOURCE_CARD_STAGGER_MS}ms">
      <div class="st"><span class="n">[${source.n}]</span><span class="ttl">${escapeHtml(source.title || source.url)}</span></div>
      <div class="m">
        ${tierBadgeHtml(source.tier)}<span>${escapeHtml(source.domain || domainFromUrl(source.url))}</span>
        <span>${sourceDateHtml(source)}</span>
        ${source.kind === "fact" ? "<span>fact ledger</span>" : ""}
      </div>
      <div class="quote">${escapeHtml(source.quote)}</div>
      <a class="lnk" href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.url)}</a>
    </article>`;
}

/**
 * A source's date, labelled by where it came from. The three cases are genuinely
 * different claims: a page fetched live today is current, a published date is
 * historical, and no date at all must be said out loud rather than left blank.
 */
function sourceDateHtml(source) {
  if (source.date_kind === "live") {
    return `<span class="live-dot">●</span> live page · fetched ${escapeHtml(source.effective_date || "")}`;
  }
  if (source.published_at) return "published " + escapeHtml(source.published_at);
  return "undated";
}

/** Clicking a `[n]` chip highlights exactly one source card and scrolls to it. */
function wireCitationClicks() {
  $$(".cite", $("#answerSlot")).forEach((chip) => {
    chip.onclick = () => {
      const card = $("#src-" + chip.dataset.n);
      /* A citation can point at a number with no card when the answer came from
         the fallback endpoint with a truncated source list; do nothing rather
         than clear the highlight the user already has. */
      if (!card) return;
      $$(".source").forEach((element) => element.classList.remove("hl"));
      $$(".cite").forEach((element) => element.classList.remove("on"));
      card.classList.add("hl");
      chip.classList.add("on");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
}

/* ---------------------------------------------------------------------------
   Retrieval trace
   --------------------------------------------------------------------------- */

/* Enough rows to see where the cut-off fell without turning the page into a table
   dump; the selected chunks are always near the top by construction. */
const TRACE_CANDIDATE_LIMIT = 40;
/* Widest score bar, in px — the trace column is fixed-width in styles.css. */
const TRACE_SCORE_BAR_MAX_PX = 54;
/* Titles are truncated to keep the row on one line at 1280 px. */
const TRACE_TITLE_CHARS = 64;

/**
 * "Why these sources" — the ranked candidate list with every score component
 * shown separately. This is the auditable part of retrieval: it is what lets a
 * reviewer check that the selected chunks were selected for stated reasons and
 * not chosen after the fact to match the answer.
 */
function renderTrace(result) {
  const trace = result.trace;
  if (!trace?.candidates?.length) {
    $("#traceSlot").innerHTML = "";
    return;
  }

  /* Score bars are relative to the best candidate; hybrid scores are ~0.01 and
     carry no meaning in absolute terms. The floor avoids dividing by zero. */
  const bestScore = Math.max(...trace.candidates.map((candidate) => candidate.score), 1e-9);
  /* chunk_id → why it was selected ("top" or "date-diverse"), for the row styling. */
  const selectionReasonByChunk = new Map(
    (trace.selected || []).map((chunk) => [chunk.chunk_id, chunk.selected_by]));

  $("#traceSlot").innerHTML = `<details class="trace">
    <summary>Why these sources — retrieval trace</summary>
    <div class="trace-meta">${traceMetaHtml(trace)}</div>
    <div class="legend"><span class="sel"><i></i>sent to the model</span><span class="dd"><i></i>added for date diversity</span></div>
    <div class="tablewrap"><table><thead><tr>
      <th>#</th><th>source</th><th>date</th><th>tier</th><th>bm25</th><th>vec</th><th>rrf</th><th>recency</th><th>auth</th><th>score</th><th></th>
    </tr></thead><tbody>${trace.candidates.slice(0, TRACE_CANDIDATE_LIMIT)
      .map((candidate, index) =>
        candidateRowHtml(candidate, index, selectionReasonByChunk, bestScore))
      .join("")}</tbody></table></div>
    ${traceFactTableHtml(trace.facts || [])}
  </details>`;

  wireDocLinks($("#traceSlot"));
}

/** The pill strip above the table: what the query was and how it was configured. */
function traceMetaHtml(trace) {
  const tierWeights = trace.config
    ? Object.values(trace.config.ranking.tier_weights).join("/")
    : "";
  return [
    `FTS <code>${escapeHtml(trace.fts_query || "—")}</code>`,
    `vector ${trace.vector_used ? "on" : "off"}`,
    `${trace.candidates.length} candidates`,
    `${(trace.selected || []).length} to the model`,
    `${(trace.facts || []).length} fact rows`,
    `model ${trace.model || "not called"}`,
    /* Echoing the ranking knobs here is what makes a Settings change provable:
       change a weight, re-ask, and the trace says which weights produced the row
       order below. */
    trace.config
      ? `half-life ${trace.config.ranking.recency_half_life_days}d · tiers ${tierWeights}`
      : "",
  ].filter(Boolean).map((text) => `<span class="pill quiet">${text}</span>`).join("");
}

function candidateRowHtml(candidate, index, selectionReasonByChunk, bestScore) {
  const reason = selectionReasonByChunk.get(candidate.chunk_id);
  let rowClass = "";
  if (reason === "date-diverse") rowClass = "dd";
  else if (selectionReasonByChunk.has(candidate.chunk_id)) rowClass = "selected";

  let outcome = "";
  if (reason === "date-diverse") outcome = "date-diverse";
  else if (selectionReasonByChunk.has(candidate.chunk_id)) outcome = "→ model";

  const barWidthPx = Math.round(TRACE_SCORE_BAR_MAX_PX * candidate.score / bestScore);
  /* `?? "—"` and not `|| "—"`: rank 0 is the best possible rank, not a missing one. */
  return `
      <tr class="${rowClass}">
        <td class="num">${index + 1}</td>
        <td><a href="#" class="doclink" data-doc="${candidate.doc_id}">${escapeHtml((candidate.title || candidate.url).slice(0, TRACE_TITLE_CHARS))}</a>
            <div class="subtle">${escapeHtml(domainFromUrl(candidate.url))}${candidate.ai_directed ? " · AI-directed page" : ""}</div></td>
        <td class="num">${candidate.effective_date || "—"}${candidate.date_kind === "live" ? '<div class="subtle">live</div>' : ""}</td>
        <td>${tierBadgeHtml(candidate.tier)}</td>
        <td class="num">${candidate.bm25_rank ?? "—"}</td>
        <td class="num">${candidate.vec_rank ?? "—"}${candidate.cosine != null ? `<div class="subtle">${candidate.cosine}</div>` : ""}</td>
        <td class="num">${candidate.rrf}</td><td class="num">${candidate.recency}</td><td class="num">${candidate.authority}</td>
        <td class="num"><span class="bar" style="width:${barWidthPx}px"></span>${candidate.score}</td>
        <td class="subtle">${outcome}</td>
      </tr>`;
}

/** The fact-ledger rows that were handed to the model alongside the chunks. */
function traceFactTableHtml(facts) {
  if (!facts.length) return "";
  return `<h3 class="h">Fact ledger rows handed to the model</h3>
      <div class="tablewrap"><table><thead><tr><th>key</th><th>value</th><th>as of</th><th>source</th></tr></thead><tbody>
      ${facts.map((fact) => `<tr><td><code>${escapeHtml(fact.key)}</code></td><td>${escapeHtml(fact.value)}</td><td class="num">${fact.as_of || "—"}</td>
        <td>${tierBadgeHtml(fact.tier)} <a href="${escapeHtml(fact.url)}" target="_blank" rel="noopener">${escapeHtml(domainFromUrl(fact.url))}</a></td></tr>`).join("")}
      </tbody></table></div>`;
}

/* ---------------------------------------------------------------------------
   Facts timeline view
   --------------------------------------------------------------------------- */

/* How the `as_of` date was established. Anything unrecognised is treated as a
   document date, which is the weakest of the three claims. */
const DATE_SOURCE_LABELS = {
  text: "date in text",
  document: "document date",
  "live-page": "live page, fetched",
};
const dateSourceLabel = (source) => DATE_SOURCE_LABELS[source] || "document date";

/** Sources listed under a timeline entry before it collapses into "+N more". */
const FACT_SOURCES_SHOWN = 4;
const FACT_SOURCE_TITLE_CHARS = 62;

/**
 * The history of one fact key. The point of this view is that a value like
 * "networks supported" has a history rather than a current truth, so the answerer
 * dates its claims instead of picking the newest row and calling it fact.
 */
async function loadFacts() {
  /* Falling back to an empty list keeps the (otherwise empty) view usable when
     the API is down, instead of leaving a blank panel with no explanation. */
  const rows = await fetchJson("/api/facts").catch(() => []);
  const keys = [...new Set(rows.map((row) => row.key))].sort();

  $("#factKey").innerHTML = keys.map((key) =>
    /* networks_supported is preselected because it is the key with the richest
       history, and therefore the one that demonstrates the view. */
    `<option ${key === "networks_supported" ? "selected" : ""}>${escapeHtml(key)}</option>`).join("");

  const drawSelectedKey = () => {
    const groups = groupFactRows(rows, $("#factKey").value);
    $("#factTimeline").innerHTML = groups.map(factTimelineEntryHtml).join("")
      || '<div class="empty">No rows for this key.</div>';
    wireDocLinks($("#factTimeline"));
  };
  $("#factKey").onchange = drawSelectedKey;
  drawSelectedKey();
}

/**
 * Group a key's rows by value-and-year, preserving the ledger's order.
 *
 * Without the grouping, one value repeated across forty pages produces forty
 * identical timeline entries and the actual changes disappear. The year is part of
 * the group key so that the same value re-stated in a later year still shows as a
 * separate point in the history.
 */
function groupFactRows(rows, key) {
  const groups = [];
  for (const fact of rows.filter((row) => row.key === key)) {
    const groupKey = `${fact.value.toLowerCase()}|${(fact.as_of || "").slice(0, 4)}`;
    let group = groups.find((candidate) => candidate.groupKey === groupKey);
    if (!group) {
      group = { groupKey, first: fact, items: [] };
      groups.push(group);
    }
    group.items.push(fact);
  }
  return groups;
}

function factTimelineEntryHtml({ first: fact, items }) {
  const extraSources = items.length > FACT_SOURCES_SHOWN
    ? `<br><span class="dim">+${items.length - FACT_SOURCES_SHOWN} more</span>`
    : "";
  const sourceLinks = items.slice(0, FACT_SOURCES_SHOWN).map((item) =>
    `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml((item.title || item.url).slice(0, FACT_SOURCE_TITLE_CHARS))}</a>`
    + ` · <a href="#" class="doclink" data-doc="${item.doc_id}">doc ${item.doc_id}</a>`).join("<br>");

  return `
      <div class="tl t${fact.tier}">
        <div class="d">${escapeHtml(fact.as_of || "undated")}<small>${dateSourceLabel(fact.as_of_source)}</small></div>
        <div>
          <div class="v">${escapeHtml(fact.value)} ${tierBadgeHtml(fact.tier)}
            ${items.length > 1 ? `<span class="pill quiet">${items.length} sources</span>` : ""}
            ${fact.ai_directed ? '<span class="pill quiet">AI-directed page</span>' : ""}
            ${fact.flags ? `<span class="pill" style="color:var(--err)">${escapeHtml(fact.flags)}</span>` : ""}</div>
          <div class="q">“${escapeHtml(fact.quote)}”</div>
          <div class="s">${sourceLinks}${extraSources}</div>
        </div>
      </div>`;
}

/* ---------------------------------------------------------------------------
   Corpus view
   --------------------------------------------------------------------------- */

/* Wait for a pause in typing before hitting /api/docs; 250 ms is the usual
   "finished a word" threshold and keeps a fast typist to one request. */
const DOC_SEARCH_DEBOUNCE_MS = 250;
const DEDUP_URL_CHARS = 54;
const DOC_TITLE_CHARS = 78;
const DOC_URL_CHARS = 88;
/* Shortest visible year bar, in % — a year with one document must still be seen. */
const MIN_YEAR_BAR_PERCENT = 4;

/**
 * What the crawler found, merged and threw away. This view is the evidence for
 * the corpus-quality claims in the report: coverage, dedup rate, and the share of
 * documents that carry a real publication date.
 */
async function loadCorpus() {
  const stats = await fetchJson("/api/stats");
  renderCorpusTiles(stats);
  renderDomainTable(stats.by_domain);
  renderYearBars(stats.by_year);
  renderDedupSummary(stats);
  renderDroppedTable(stats.dropped);

  const clusters = await fetchJson("/api/dedup");
  $("#dedupTable tbody").innerHTML = clusters.map(dedupRowHtml).join("");

  wireDocSearch();
}

function renderCorpusTiles(stats) {
  const documents = stats.documents;
  const datedPercent = Math.round(100 * documents.dated / Math.max(documents.canonical, 1));
  const totalCost = stats.cost.reduce((sum, row) => sum + row.cost_usd, 0);

  const tiles = [
    ["canonical documents", documents.canonical],
    ["fetched incl. aliases", documents.ok],
    ["duplicates / aliases", documents.aliases],
    ["dropped at crawl", documents.dropped],
    ["with a publication date", `${documents.dated} · ${datedPercent}%`],
    ["AI-directed pages", documents.ai_directed],
    ["chunks", `${stats.chunks.total}`],
    ["embedded", `${stats.chunks.embedded}`],
    ["AI sentences removed", `${stats.instructions.sentences}`],
    ["facts in ledger", `${stats.facts.total}`],
    ["fact keys", stats.facts.keys],
    ["total spent", formatUsd(totalCost)],
  ];
  $("#statTiles").innerHTML = tiles
    .map(([label, value]) => `<div class="tile"><div class="v">${escapeHtml(value)}</div><div class="l">${label}</div></div>`)
    .join("");
}

function renderDomainTable(byDomain) {
  $("#domainTable tbody").innerHTML = byDomain.map((row) =>
    `<tr><td>${escapeHtml(row.domain)}</td><td>${tierBadgeHtml(row.tier)}</td><td class="num">${row.docs}</td><td class="num">${row.aliases}</td><td class="num">${row.oldest || "—"}</td><td class="num">${row.newest || "—"}</td></tr>`)
    .join("");
}

/** Bars are scaled to the busiest year, so the shape of the corpus is visible. */
function renderYearBars(byYear) {
  const busiestYear = Math.max(...byYear.map((year) => year.docs), 1);
  $("#yearBars").innerHTML = byYear.map((year) => {
    const heightPercent = Math.max(MIN_YEAR_BAR_PERCENT, Math.round(100 * year.docs / busiestYear));
    return `<div class="b" style="height:${heightPercent}%"><span>${year.docs}</span><i>${year.year}</i></div>`;
  }).join("");
}

/** Which dedup method caught how many aliases — exact hash, canonical tag, similarity. */
function renderDedupSummary(stats) {
  const methods = stats.dedup.map((method) =>
    `<code>${method.method}</code> ${method.n}`
    + (method.avg_similarity ? ` (avg sim ${method.avg_similarity})` : "")).join(", ") || "none";
  $("#dedupSummary").innerHTML =
    `<p class="dim" style="font-size:13px;margin-bottom:10px">${stats.documents.aliases} aliases in clusters, by method: ${methods}</p>`;
}

function dedupRowHtml(cluster) {
  /* The scheme is stripped and the rest truncated because what distinguishes an
     alias from its canonical is almost always the tail of the path. */
  const shortUrl = (url) => escapeHtml(url.replace(/^https?:\/\//, "").slice(0, DEDUP_URL_CHARS));
  return `<tr><td><a href="${escapeHtml(cluster.alias_url)}" target="_blank" rel="noopener">${shortUrl(cluster.alias_url)}</a></td><td><a href="${escapeHtml(cluster.canonical_url)}" target="_blank" rel="noopener">${shortUrl(cluster.canonical_url)}</a></td><td><code>${escapeHtml(cluster.method)}</code></td><td class="num">${cluster.similarity ?? ""}</td></tr>`;
}

function renderDroppedTable(dropped) {
  $("#droppedTable tbody").innerHTML = dropped
    .map((row) => `<tr><td>${escapeHtml(row.reason)}</td><td class="num">${row.n}</td></tr>`)
    .join("");
}

/** The document browser at the bottom of the corpus view, filtered server-side. */
function wireDocSearch() {
  const drawDocuments = async () => {
    const query = encodeURIComponent($("#docSearch").value);
    const documents = await fetchJson("/api/docs?q=" + query);
    $("#docTable tbody").innerHTML = documents.map(docRowHtml).join("");
    wireDocLinks($("#docTable"));
  };

  let debounceHandle;
  $("#docSearch").oninput = () => {
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(drawDocuments, DOC_SEARCH_DEBOUNCE_MS);
  };
  drawDocuments();
}

function docRowHtml(doc) {
  /* Dropped, alias and AI-directed documents stay listed rather than being hidden:
     the point of the view is what happened to everything the crawler saw. */
  const flags = (doc.status === "dropped" ? "dropped: " + escapeHtml(doc.drop_reason) : "")
    + (doc.duplicate_of ? "alias of " + doc.duplicate_of : "")
    + (doc.ai_directed ? " AI-directed" : "");

  return `<tr>
      <td class="num"><a href="#" class="doclink" data-doc="${doc.id}">${doc.id}</a></td>
      <td>${escapeHtml((doc.title || doc.url).slice(0, DOC_TITLE_CHARS))}<div class="subtle">${escapeHtml(doc.url.slice(0, DOC_URL_CHARS))}</div></td>
      <td>${escapeHtml(doc.domain)}</td><td>${tierBadgeHtml(doc.tier)}</td><td class="num">${doc.published_at || "—"}</td><td class="num">${doc.text_chars ?? ""}</td>
      <td class="subtle">${flags}</td></tr>`;
}

/* ---------------------------------------------------------------------------
   AI instructions view
   --------------------------------------------------------------------------- */

/**
 * The sentences that were addressed to AI assistants and cut out of the searchable
 * text at index time. Showing them is the proof of the prompt-injection defence:
 * they were found, removed from the index, and parked here where neither the
 * retriever nor the answer model can meet them as instructions.
 */
async function loadInstructions() {
  const rows = await fetchJson("/api/instructions");
  const byDocument = groupInstructionsByDocument(rows);

  $("#instrSummary").textContent = `${rows.length} sentences in ${byDocument.size} documents`;
  $("#instrList").innerHTML = [...byDocument.values()].map(instructionGroupHtml).join("")
    || '<div class="empty">None found.</div>';
  wireDocLinks($("#instrList"));
}

/** One entry per document, carrying that document's metadata plus all its sentences. */
function groupInstructionsByDocument(rows) {
  const byDocument = new Map();
  for (const row of rows) {
    if (!byDocument.has(row.doc_id)) byDocument.set(row.doc_id, { ...row, list: [] });
    byDocument.get(row.doc_id).list.push(row);
  }
  return byDocument;
}

function instructionGroupHtml(group) {
  /* A page flagged AI-directed as a whole is a stronger signal than one stray
     sentence, and it also carries a ranking penalty, so it is called out. */
  const pageFlag = group.ai_directed
    ? '<span class="pill quiet">whole page flagged AI-directed</span> '
    : "";
  return `
    <div class="instr">
      <div class="u">${pageFlag}<a href="${escapeHtml(group.url)}" target="_blank" rel="noopener">${escapeHtml(group.title || group.url)}</a> · <a href="#" class="doclink" data-doc="${group.doc_id}">doc ${group.doc_id}</a></div>
      ${group.list.map((row) => `<div class="s">“${escapeHtml(row.sentence)}”</div>`).join("")}
    </div>`;
}

/* ---------------------------------------------------------------------------
   Eval view
   --------------------------------------------------------------------------- */

/* Verdict → cell class. A correct abstention counts as a success: refusing a trap
   question is the behaviour under test, not a failure to answer. */
const VERDICT_CLASSES = {
  correct: "v-ok",
  abstained_correctly: "v-ok",
  partially_correct: "v-part",
};
const verdictClass = (verdict) => VERDICT_CLASSES[verdict] || "v-bad";

/** The last eval run and the measured cost of the whole system to date. */
async function loadEval() {
  const [run, cost] = await Promise.all([fetchJson("/api/eval"), fetchJson("/api/cost")]);
  if (!run) {
    $("#evalTiles").innerHTML = '<div class="empty">No eval run yet — <code>npm run eval</code>.</div>';
  } else {
    renderEvalTiles(run.metrics);
    renderEvalTable(run.rows);
  }
  /* One line and a way through, rather than the raw JSON dump that used to live here: the
     Cost view renders the same object properly, and two renderings of one endpoint invite
     the reader to wonder which is authoritative. */
  /* The same `headline` object the Cost view uses, so the two pages cannot quote different
     figures for the same thing — which they did until this stopped reading `index.cost_usd`,
     an all-time total that counts every superseded embedding run. */
  $("#evalCostLine").innerHTML =
    `<span>Every question above is in the ledger. Building the index cost <b>${formatMoney(cost.headline?.build_cost_usd)}</b>; `
    + `one question averages <b>${formatMoney(cost.headline?.per_question_usd)}</b>; `
    + `everything ever spent on this project, evaluation included, is <b>${formatMoney(cost.total_spent_usd)}</b>.</span>`
    + `<button class="btn-ghost sm" data-view="cost" type="button">Open the Cost view →</button>`;
  $("#evalCostLine button").onclick = () => showView("cost");
}

function renderEvalTiles(metrics) {
  const tiles = [
    ["accuracy strict", formatPercent(metrics.accuracy_strict)],
    ["accuracy lenient", formatPercent(metrics.accuracy_lenient)],
    ["successful", metrics.successful],
    ["failed", metrics.failed],
    ["invented a fact", metrics.hallucinated],
    ["abstained ok / wrongly", `${metrics.abstained_correctly} / ${metrics.abstained_wrongly}`],
    ["avg cost / question", formatUsd(metrics.avg_cost_per_question_usd)],
    ["avg latency", formatDuration(metrics.avg_latency_ms)],
  ];
  $("#evalTiles").innerHTML = tiles
    .map(([label, value]) => `<div class="tile"><div class="v">${escapeHtml(value)}</div><div class="l">${label}</div></div>`)
    .join("");
}

function renderEvalTable(rows) {
  $("#evalTable tbody").innerHTML = rows.map((row) => {
    /* A human verdict overrides the automatic one — the automatic judge is a
       convenience, the recorded human call is the result. */
    const verdict = row.human_verdict || row.verdict;
    return `<tr><td class="num">${row.id}${row.trap ? " ⚠" : ""}</td><td>${escapeHtml(row.question)}</td><td class="dim">${escapeHtml(row.reference)}</td>
        <td>${escapeHtml(row.system_answer)}${row.as_of ? `<div class="subtle">as of ${row.as_of}</div>` : ""}</td>
        <td class="${verdictClass(verdict)}">${escapeHtml(verdict)}${row.human_verdict ? " (human)" : ""}<div class="subtle" style="font-weight:400">${escapeHtml(row.reason)}</div></td></tr>`;
  }).join("");
}

/* ---------------------------------------------------------------------------
   Cost view
   ---------------------------------------------------------------------------

   The money-and-resources view. Everything here comes from GET /api/cost, which
   is the same object `npm run cost` renders COST.md from — so the page and the
   committed file cannot disagree, and neither can invent a number.

   The design rule for this view specifically: a figure that was never measured
   must look different from a figure that was measured as zero. Hence "—" for
   the first and "$0" / "free" for the second, everywhere below.
   --------------------------------------------------------------------------- */

/* One colour per stage, drawn from the palette the rest of the app already uses
   (three tier hues, the accent, and two semantic colours) rather than a new
   chart palette — the bars have to look like part of this product. */
const STAGE_COLORS = {
  crawl: "var(--t1)",
  dedup: "var(--t2)",
  index: "var(--t3)",
  facts: "var(--accent)",
  eval: "var(--idk)",
  question: "var(--ok)",
};

/* A segment thinner than this is invisible and unhoverable, so a stage that cost
   a rounding error still gets a sliver rather than disappearing from the bar. */
const MIN_BAR_SEGMENT_PERCENT = 0.6;

/* Which stages make up "building the index". `eval` and `question` are running
   costs, not build costs, and folding them in would inflate the headline. */
const BUILD_STAGES = ["crawl", "dedup", "index", "facts"];

/**
 * Money on the Cost view. Distinct from `formatUsd` in pipeline.js in one way that matters:
 * a measured zero prints as the word "free", never as "$0.00000", so a stage that calls no
 * model reads as free rather than as a suspiciously precise nothing. A missing figure is "—".
 */
function formatMoney(usd) {
  if (usd == null) return "—";
  if (usd === 0) return "free";
  if (usd < 0.000001) return "<$0.000001";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Bytes → "41.2 MB". Display only. */
function formatBytes(bytes) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Durations on this view run from a 3 ms SQLite read to a 40-minute crawl, which
 * is why it does not reuse `formatDuration` from pipeline.js: that one tops out
 * at seconds, and "2361.4 s" is not a number anybody reads.
 */
function formatDurationLong(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Thin spaces between thousands: 2 220 380 reads faster than 2220380 in a table. */
const groupDigits = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US").replace(/,/g, " "));

/** The whole view. One fetch, then six renderers over the same object. */
async function loadCost() {
  const report = await fetchJson("/api/cost");
  renderCostHero(report);
  renderCostBars(report.pipeline || []);
  renderCostStages(report.pipeline || []);
  renderCostReceipt(report.receipt_example);
  renderCostHonesty(report);
  renderCostPrices(report.prices);
}

/**
 * The ten-second version: one sentence, one "where it goes" line, six tiles.
 *
 * The headline is composed here rather than served pre-written, because it has to
 * read as a sentence in the UI's own voice — but every number in it is the same
 * field COST.md uses, so the two say the same thing in different words.
 */
function renderCostHero(report) {
  /* `report.headline` is computed server-side, from the same figures COST.md quotes, so the
     page and the file cannot headline different numbers. In particular `per_question_usd` is
     the measured cost on the CURRENTLY configured model, not the all-time average across
     every model this project has experimented with — those differ by 4× here. */
  const headline = report.headline || {};
  const stages = report.pipeline || [];
  const build = stages.filter((stage) => BUILD_STAGES.includes(stage.id));
  const perQuestion = headline.per_question_usd ?? report.per_query?.avg_cost_usd ?? 0;

  $("#costHeadline").innerHTML =
    `Building the whole index cost <b>${formatMoney(headline.build_cost_usd)}</b>.`
    + `<br>One question costs about <b>${formatMoney(perQuestion)}</b>.`;

  const costLeader = [...build].sort((a, b) => b.cost_usd - a.cost_usd)[0];
  const timeLeader = [...build].sort((a, b) => (b.wall_ms || 0) - (a.wall_ms || 0))[0];
  const share = (part, whole) => (whole ? Math.round(100 * part / whole) : 0);
  $("#costWhere").innerHTML = costLeader
    ? `<b>${share(costLeader.cost_usd, headline.build_cost_usd)}%</b> of the build cost is `
      + `${escapeHtml(costLeader.plain.replace(/\.$/, "").toLowerCase())}, and `
      + `<b>${share(timeLeader?.wall_ms || 0, headline.build_wall_ms)}%</b> of the build time is `
      + `${escapeHtml((timeLeader?.label || "").toLowerCase())} — polite, one page at a time.`
    : "";

  const tiles = [
    ["index build, one-off", formatMoney(headline.build_cost_usd)],
    ["build wall time", headline.build_wall_ms ? formatDurationLong(headline.build_wall_ms) : "—"],
    [`one question · ${escapeHtml(headline.per_question_basis || "")}`, formatMoney(perQuestion)],
    ["1 000 questions", formatMoney(perQuestion * 1000)],
    ["×50 corpus, index build", formatMoney(build.reduce((total, stage) => total + stage.x50.cost_usd, 0))],
    ["spent on the project so far, experiments included", formatMoney(report.total_spent_usd)],
  ];
  $("#costTiles").innerHTML = tiles
    .map(([label, value]) => `<div class="tile"><div class="v">${escapeHtml(value)}</div><div class="l">${label}</div></div>`)
    .join("");

  $("#costMachine").textContent =
    `Timings measured on ${report.machine?.current || "an unrecorded machine"}. ${report.machine?.note || ""}`;
}

/**
 * Two stacked bars: money by stage, and wall time by stage. Side by side, because
 * the entire point of the pair is that they have different shapes — the money is
 * almost all fact extraction, the time is almost all crawling.
 */
function renderCostBars(stages) {
  const money = stages.filter((stage) => stage.cost_usd > 0);
  const time = stages.filter((stage) => stage.wall_ms > 0);
  $("#costBars").innerHTML =
    stackedBarHtml("Money · one run of each stage", money, (stage) => stage.cost_usd, formatMoney)
    + stackedBarHtml("Wall time · one run of each stage", time, (stage) => stage.wall_ms, formatDurationLong);
}

function stackedBarHtml(title, stages, value, format) {
  const total = stages.reduce((sum, stage) => sum + value(stage), 0);
  if (!total) {
    return `<div class="cost-bar"><div class="cb-head"><span>${title}</span><span class="dim mono">not measured yet</span></div>
      <div class="cb-track empty-track"></div></div>`;
  }
  const segments = stages.map((stage) => {
    const percent = Math.max(MIN_BAR_SEGMENT_PERCENT, 100 * value(stage) / total);
    return `<i style="width:${percent}%;background:${STAGE_COLORS[stage.id] || "var(--line-hard)"}"
              title="${escapeHtml(stage.label)} · ${escapeHtml(format(value(stage)))} · ${Math.round(100 * value(stage) / total)}%"></i>`;
  }).join("");

  /* Only the segments worth naming get a legend entry; below 3% the label would
     be longer than the thing it labels. */
  const legend = stages
    .filter((stage) => 100 * value(stage) / total >= 3)
    .map((stage) => `<span class="cb-key"><i style="background:${STAGE_COLORS[stage.id] || "var(--line-hard)"}"></i>`
      + `${escapeHtml(stage.label)} <b>${escapeHtml(format(value(stage)))}</b> `
      + `<span class="dim">${Math.round(100 * value(stage) / total)}%</span></span>`)
    .join("");

  return `<div class="cost-bar">
    <div class="cb-head"><span>${title}</span><span class="mono dim">${escapeHtml(format(total))} total</span></div>
    <div class="cb-track">${segments}</div>
    <div class="cb-legend">${legend}</div>
  </div>`;
}

/** The stage table. Each row expands into the individual runs behind its averages. */
function renderCostStages(stages) {
  $("#costStages tbody").innerHTML = stages.map(costStageRowHtml).join("");
  $("#costStageNotes").innerHTML = stages
    .map((stage) => `<p><b style="color:${STAGE_COLORS[stage.id]}">${escapeHtml(stage.label)}</b> — ${escapeHtml(stage.plain)}`
      + (stage.unattributed_cost_usd > 0
        ? ` <span class="dim">${formatMoney(stage.unattributed_cost_usd)} of this (${stage.unattributed_calls} calls) was logged before per-stage measurement existed: the money is exact, the time and memory behind it are not recoverable and are left blank.</span>`
        : "")
      + `</p>`)
    .join("");

  /* Delegated from the tbody: the rows are replaced wholesale on every render, so
     a handler bound per row would be thrown away with them. */
  $("#costStages tbody").onclick = (event) => {
    const row = event.target.closest("tr.cost-stage");
    if (!row) return;
    const detail = row.nextElementSibling;
    if (!detail?.classList.contains("cost-runs")) return;
    detail.hidden = !detail.hidden;
    row.classList.toggle("open", !detail.hidden);
  };
}

function costStageRowHtml(stage) {
  const units = stage.items == null
    ? "—"
    : `${groupDigits(stage.items)} <span class="dim">${escapeHtml(stage.item_unit || "")}</span>`;
  const cached = stage.cache_read
    ? `<div class="subtle">${groupDigits(stage.cache_read)} cached</div>` : "";

  return `<tr class="cost-stage" data-stage="${stage.id}">
      <td><span class="cost-dot" style="background:${STAGE_COLORS[stage.id]}"></span><b>${escapeHtml(stage.label)}</b>
        <div class="subtle">${stage.runs
        ? `${stage.runs} run${stage.runs === 1 ? "" : "s"} recorded · ${escapeHtml(stage.basis)} · click to expand`
        : "no measured run — money from the ledger tag alone"}</div></td>
      <td><span class="pill quiet">${escapeHtml(stage.what_runs)}</span></td>
      <td class="subtle">${stage.models.length ? stage.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(" ") : "—"}</td>
      <td class="num">${units}</td>
      <td class="num">${stage.tokens_in ? groupDigits(stage.tokens_in) : "—"}${cached}</td>
      <td class="num">${stage.tokens_out ? groupDigits(stage.tokens_out) : "—"}</td>
      <td class="num"><b>${formatMoney(stage.cost_usd)}</b></td>
      <td class="num">${formatDurationLong(stage.wall_ms)}</td>
      <td class="num">${formatDurationLong(stage.cpu_ms)}</td>
      <td class="num">${formatBytes(stage.peak_rss_bytes)}</td>
      <td class="num">${formatMoney(stage.cost_per_unit_usd)}</td>
      <td class="num">${stage.x50.scales === "constant" ? '<span class="dim">unchanged</span>' : `<b>${formatMoney(stage.x50.cost_usd)}</b>`}
        <div class="subtle">${escapeHtml(stage.x50.scales)}</div></td>
    </tr>
    <tr class="cost-runs" hidden><td colspan="12">${stageRunsHtml(stage)}</td></tr>`;
}

/** The expanded panel: the ×50 arithmetic in words, then every individual run. */
function stageRunsHtml(stage) {
  const arithmetic = `<div class="cost-formula"><span class="k">×50</span>${escapeHtml(stage.x50.formula)}</div>`;
  if (!stage.runs_detail.length) {
    return arithmetic + `<div class="dim" style="padding:10px 0;font-size:13px">No measured runs yet — this stage's money comes from ledger rows written before per-stage measurement existed, so it has no time or memory figures.</div>`;
  }
  return arithmetic + `<table class="inner"><thead><tr>
      <th>started</th><th>wall</th><th>cpu</th><th>peak ram</th><th>units</th><th>downloaded</th><th>cost</th><th>run id</th>
    </tr></thead><tbody>${stage.runs_detail.map((run) => `<tr>
      <td class="num">${escapeHtml(run.started_at.slice(0, 19).replace("T", " "))}${run.ok ? "" : ' <span style="color:var(--err)">failed</span>'}</td>
      <td class="num">${formatDurationLong(run.wall_ms)}</td>
      <td class="num">${formatDurationLong(run.cpu_ms)}</td>
      <td class="num">${formatBytes(run.peak_rss_bytes)}</td>
      <td class="num">${run.items == null ? "—" : `${groupDigits(run.items)} ${escapeHtml(run.item_unit || "")}`}</td>
      <td class="num">${run.bytes_in ? formatBytes(run.bytes_in) : "—"}</td>
      <td class="num">${formatMoney(run.cost_usd)}</td>
      <td class="subtle mono">${escapeHtml(run.run_id)}</td>
    </tr>`).join("")}</tbody></table>`;
}

/** The worked example: one question that really happened, priced line by line. */
function renderCostReceipt(receipt) {
  if (!receipt?.rows?.length) {
    $("#costReceipt").innerHTML =
      '<div class="empty">No question has been answered under measurement yet. Ask one, then reload this view.</div>';
    return;
  }
  $("#costReceipt").innerHTML = `<div class="receipt">
    <div class="rc-head">
      <span class="rc-q">“${escapeHtml(receipt.question)}”</span>
      <span class="dim mono">${escapeHtml((receipt.asked_at || "").slice(0, 19).replace("T", " "))} · ${escapeHtml(receipt.status || "")}</span>
    </div>
    ${receiptRowsHtml(receipt)}
  </div>`;
}

/**
 * The receipt body, shared by this view and the one under every answer, so a
 * question's receipt looks the same wherever it is read.
 * Exported through `window` rather than a module import because pipeline.js is
 * loaded as a sibling module and importing app.js from it would be circular.
 */
function receiptRowsHtml(receipt) {
  const total = receipt.total;
  const rows = receipt.rows.map((row) => `<div class="rc-row ${row.kind}${row.nested ? " nested" : ""}">
      <span class="rc-n">${row.n}</span>
      <span class="rc-what"><b>${escapeHtml(row.label)}</b><span class="rc-detail">${escapeHtml(row.detail)}</span></span>
      <span class="rc-tok">${row.tokens_in || row.tokens_out
        ? `${groupDigits(row.tokens_in)} in${row.cache_read ? ` <span class="dim">(${groupDigits(row.cache_read)} cached)</span>` : ""} · ${groupDigits(row.tokens_out)} out`
        : '<span class="dim">no tokens</span>'}</span>
      <span class="rc-usd">${row.usd ? formatMoney(row.usd) : '<span class="dim">free</span>'}</span>
      <span class="rc-ms">${formatDurationLong(row.ms)}${row.nested ? "*" : ""}</span>
    </div>`).join("");

  return rows + `<div class="rc-row rc-total">
      <span class="rc-n">Σ</span>
      <span class="rc-what"><b>Total</b><span class="rc-detail">${total.model_calls} model call${total.model_calls === 1 ? "" : "s"}, ${total.tool_calls} tool call${total.tool_calls === 1 ? "" : "s"}</span></span>
      <span class="rc-tok">${groupDigits(total.tokens_in)} in${total.cache_read ? ` <span class="dim">(${groupDigits(total.cache_read)} cached)</span>` : ""} · ${groupDigits(total.tokens_out)} out</span>
      <span class="rc-usd"><b>${formatMoney(total.usd)}</b></span>
      <span class="rc-ms"><b>${formatDurationLong(total.wall_ms)}</b></span>
    </div>
    <p class="rc-foot">* runs inside the step above it, so its time is already counted there.
      The steps account for ${formatDurationLong(total.accounted_ms)} of the ${formatDurationLong(total.wall_ms)};
      the other ${formatDurationLong(total.unaccounted_ms)} is orchestration — database writes, JSON, the gates.
      The total is the sum of the ledger rows this question wrote, re-read from the database, not a counter the agent kept.</p>`;
}

/* pipeline.js renders the per-answer receipt with the same markup; this is the
   simplest way to share it without making the two modules import each other. */
window.__receiptRowsHtml = receiptRowsHtml;

/**
 * Two lists, side by side. The contrast is the point, so they are never merged.
 *
 * The strings arrive as prose with `backticks` around identifiers, because the same strings go
 * into COST.md where that is Markdown. Escaping first and then promoting the backticked spans
 * keeps the page safe from the text while still rendering the code bits as code.
 */
function renderCostHonesty(report) {
  const honesty = report.honesty || { measured: [], assumed: [] };
  const withCode = (text) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  const list = (title, items, className) =>
    `<div class="honesty ${className}"><h4>${title}</h4><ul>${items.map((item) => `<li>${withCode(item)}</li>`).join("")}</ul></div>`;
  $("#costHonesty").innerHTML =
    list("Measured", honesty.measured, "is-measured") + list("Assumed", honesty.assumed, "is-assumed");
}

function renderCostPrices(prices) {
  if (!prices) return;
  const rows = Object.entries(prices.table).map(([model, price]) =>
    `<tr><td><code>${escapeHtml(model)}</code></td><td class="num">${price.input}</td><td class="num">${price.output}</td>
      <td class="num">${price.cache_read ?? "—"}</td><td class="num">${price.cache_write ?? "—"}</td></tr>`).join("");
  $("#costPrices").innerHTML =
    `<p class="dim" style="font-size:13px;margin-bottom:10px">${escapeHtml(prices.source)}. Copied ${escapeHtml(prices.copied_on)}.</p>`
    + `<div class="tablewrap"><table><thead><tr><th>model</th><th>input</th><th>output</th><th>cache read</th><th>cache write</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ---------------------------------------------------------------------------
   Settings (operator panel)
   --------------------------------------------------------------------------- */

/* How long an "applied"/"reset" confirmation stays on screen. */
const CONFIG_MESSAGE_TIMEOUT_MS = 3500;

/** Read "ranking.tier_weights.1" out of the config object; undefined if absent. */
const readConfigPath = (object, dottedPath) =>
  dottedPath.split(".").reduce((node, key) => node?.[key], object);

/**
 * The values as last loaded from the server, keyed by `data-path`. Fields are
 * marked dirty by comparing against this rather than against a default, so a field
 * the operator typed into and then typed back stops looking modified.
 */
let savedFieldValues = {};

/**
 * Fill the operator panel from GET /api/config. Every input in index.html declares
 * its own config path in `data-path`, so this loop needs no per-field knowledge and
 * a new knob is added in HTML alone.
 */
async function loadSettings() {
  const config = await fetchJson("/api/config");
  savedFieldValues = {};

  $$("[data-path]").forEach((field) => {
    const value = readConfigPath(config, field.dataset.path);
    /* List-valued settings (excluded domains, included tiers) are edited as one
       comma-separated line; the save path splits them back apart. */
    field.value = Array.isArray(value) ? value.join(", ") : value ?? "";
    savedFieldValues[field.dataset.path] = field.value;
    field.classList.remove("dirty");
    field.oninput = field.onchange = () =>
      field.classList.toggle("dirty", field.value !== savedFieldValues[field.dataset.path]);
  });
}

/**
 * Build the nested config patch from the flat `data-path` fields.
 *
 * Every field is a string in the DOM, so the type has to be recovered from the
 * markup: `data-list` says "split on commas", `type=number` says "number", and a
 * literal "true"/"false" from a <select> becomes a boolean. Sending the raw
 * strings would store `"540"` where the ranking code expects `540`.
 */
function collectConfigPatch() {
  const patch = {};
  $$("[data-path]").forEach((field) => {
    const [section, ...rest] = field.dataset.path.split(".");
    let value = field.value;

    if (field.dataset.list === "1") {
      value = value.split(",").map((part) => part.trim()).filter(Boolean);
    } else if (field.dataset.list === "num") {
      value = value.split(",")
        .map((part) => Number(part.trim()))
        .filter((number) => !Number.isNaN(number));
    } else if (field.type === "number") {
      /* An empty number field means "no limit" (e.g. min published year), which
         the backend spells as null — an empty string would fail validation. */
      value = value === "" ? null : Number(value);
    } else if (value === "true" || value === "false") {
      value = value === "true";
    }

    patch[section] ??= {};
    /* Paths are at most three deep: "gates.min_best_score" or
       "ranking.tier_weights.1". Anything deeper is not expressible in the panel. */
    if (rest.length === 2) {
      patch[section][rest[0]] ??= {};
      patch[section][rest[0]][rest[1]] = value;
    } else {
      patch[section][rest[0]] = value;
    }
  });
  return patch;
}

$("#saveCfg").onclick = async () => {
  const patch = collectConfigPatch();

  /* tier_weights is replaced wholesale by the PUT, but the panel only exposes
     tiers 1-3. Merging the current server value back in stops a tier that exists
     in config/kb.yaml but has no input here from being deleted on every save. */
  const current = await fetchJson("/api/config");
  if (patch.ranking?.tier_weights) {
    patch.ranking.tier_weights = { ...current.ranking.tier_weights, ...patch.ranking.tier_weights };
  }

  await fetchJson("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  /* Reload rather than trust the local values: the server normalises and clamps,
     so what it stored may differ from what was typed. */
  await loadSettings();
  showConfigMessage("applied — the next question uses these settings");
};

$("#resetCfg").onclick = async () => {
  /* DELETE drops the in-memory overrides; the file on disk is untouched. */
  await fetchJson("/api/config", { method: "DELETE" });
  await loadSettings();
  showConfigMessage("reset to config/kb.yaml");
};

function showConfigMessage(text) {
  $("#cfgMsg").textContent = text;
  setTimeout(() => $("#cfgMsg").textContent = "", CONFIG_MESSAGE_TIMEOUT_MS);
}

/* ---------------------------------------------------------------------------
   Document modal
   --------------------------------------------------------------------------- */

/* At most this many stripped sentences are listed; the rest are in the AI
   instructions view, and a heavily-injected page would otherwise fill the modal. */
const MODAL_INSTRUCTIONS_SHOWN = 8;

/**
 * Make every `.doclink` inside `scope` open the document modal.
 *
 * Called after each render rather than once at startup, because every view
 * replaces its innerHTML and the previous handlers go with it. `scope` keeps a
 * re-rendered table from re-binding links in the other views.
 */
function wireDocLinks(scope) {
  $$(".doclink", scope).forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault(); // the links are href="#"; without this the page jumps to the top
      openDoc(link.dataset.doc);
    };
  });
}

/**
 * Show one indexed document in full: its metadata, the URLs it was also found at,
 * the sentences removed from it, the facts extracted from it, and the exact text
 * that went into the index. This is the "show me the actual source" affordance —
 * every table in the app links here.
 */
async function openDoc(id) {
  const doc = await fetchJson("/api/doc/" + id);
  $("#docContent").innerHTML = docModalHtml(doc);
  $("#docModal").hidden = false;
}

function docModalHtml(doc) {
  /* Styles are inline here, unlike everywhere else in the app: the modal is the
     only place these one-off type sizes are used, and styles.css has no rules for
     its internals. */
  const header = `
    <h3 style="font-family:var(--serif);font-size:25px;font-weight:500;letter-spacing:-.015em;margin-bottom:8px;padding-right:30px">${escapeHtml(doc.title || doc.url)}</h3>
    <div class="m" style="display:flex;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:11.5px;color:var(--dim);align-items:center">
      ${tierBadgeHtml(doc.tier)}<span>${escapeHtml(doc.domain)}</span><span>${escapeHtml(doc.category)}</span>
      <span>published ${doc.published_at || "unknown"}${doc.date_source ? ` (${escapeHtml(doc.date_source)})` : ""}</span>
      <span>${doc.text_chars} chars</span>${doc.ai_directed ? '<span style="color:var(--idk)">AI-directed page</span>' : ""}
      ${doc.duplicate_of ? `<span>alias of doc ${doc.duplicate_of}</span>` : ""}
    </div>`;

  /* Redirect target and canonical tag are shown because they are the inputs to the
     dedup decision — without them "alias of doc 42" is an unexplained claim. */
  const urls = `
    <div style="font-size:12.5px;margin:10px 0;font-family:var(--mono)"><a href="${escapeHtml(doc.url)}" target="_blank" rel="noopener">${escapeHtml(doc.url)}</a>
      ${doc.final_url && doc.final_url !== doc.url ? `<br><span class="dim">→ redirected to</span> ${escapeHtml(doc.final_url)}` : ""}
      ${doc.canonical_url ? `<br><span class="dim">canonical:</span> ${escapeHtml(doc.canonical_url)}` : ""}</div>`;

  const aliases = doc.aliases.length
    ? `<div style="font-size:12.5px"><b>Also found at:</b><br>${doc.aliases.map((alias) => `${escapeHtml(alias.url)} <code>${escapeHtml(alias.dedup_method)}</code>`).join("<br>")}</div>`
    : "";

  const instructions = doc.instructions.length
    ? `<div style="margin-top:12px"><b style="font-size:13px">AI-directed sentences removed (${doc.instructions.length})</b>${doc.instructions.slice(0, MODAL_INSTRUCTIONS_SHOWN).map((sentence) => `<div class="instr" style="margin-top:6px"><div class="s">“${escapeHtml(sentence)}”</div></div>`).join("")}</div>`
    : "";

  const facts = doc.facts.length
    ? `<div style="font-size:12.5px;margin-top:12px"><b>Facts extracted:</b> ${doc.facts.map((fact) => `<code>${escapeHtml(fact.key)}</code>=${escapeHtml(fact.value)}${fact.as_of ? ` (${fact.as_of})` : ""}`).join(" · ")}</div>`
    : "";

  /* The indexed text, not the original page: what the retriever actually searched,
     with the AI-directed sentences already gone. */
  const text = `<h4 class="h">Indexed text</h4><div class="doc-text">${escapeHtml(doc.text)}</div>`;

  /* Joined with a newline and indent so the emitted markup is laid out the same
     way as the rest of this file's templates — the sections are block-level, so
     the whitespace is inert. */
  const between = "\n    ";
  return header + urls + between + aliases + between + instructions
    + between + facts + between + text;
}

$("#docClose").onclick = () => $("#docModal").hidden = true;
/* Clicking the backdrop closes; clicking inside the modal body must not, hence the
   check that the click landed on the overlay itself. */
$("#docModal").onclick = (event) => {
  if (event.target.id === "docModal") $("#docModal").hidden = true;
};

/* On a normal load the Ask view is already active, so the caret starts in the
   question box. Skipped when a hash sent the user straight to another view. */
if ($("#view-ask").classList.contains("active")) $("#q").focus();
