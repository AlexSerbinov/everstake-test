/* Everstake KB — UI shell. No build step; talks only to the JSON API.
   Ask view streams POST /ask/stream (SSE over fetch), falls back to POST /ask. */

import { Pipeline, streamAsk, esc, domainOf, fmtMs, fmt$ } from "./pipeline.js";
import { mockStream, isMock } from "./mock-stream.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const tierBadge = (t) => `<span class="tier t${t}">T${t}</span>`;
const pct = (x) => Math.round((x || 0) * 100) + "%";

/* ── theme ─────────────────────────────────────────────────────────────── */
const root = document.documentElement;
try { if (localStorage.theme) root.dataset.theme = localStorage.theme; } catch {}
if (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches) root.dataset.theme = "dark";
$("#theme").onclick = () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.theme = root.dataset.theme; } catch {}
};

/* ── mock flag ─────────────────────────────────────────────────────────── */
const MOCK = isMock();
if (MOCK) {
  const f = document.createElement("div");
  f.className = "mockflag"; f.textContent = "demo mode · replayed stream";
  document.body.appendChild(f);
}

/* ── views & Explore menu ──────────────────────────────────────────────── */
const loaded = {};
const LOADERS = { facts: loadFacts, corpus: loadCorpus, instructions: loadInstructions, eval: loadEval, settings: loadSettings };

function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  closeMenu();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  location.hash = name === "ask" ? "" : name;
  if (name !== "ask" && !loaded[name]) { loaded[name] = true; LOADERS[name]?.(); }
  if (name === "ask") setTimeout(() => $("#q").focus(), 60);
}
const menu = $("#exploreMenu"), menuBtn = $("#exploreBtn");
const openMenu = () => { menu.hidden = false; menuBtn.setAttribute("aria-expanded", "true"); };
const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); };
menuBtn.onclick = (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); };
menu.onclick = (e) => { const b = e.target.closest("button"); if (b) showView(b.dataset.view); };
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closeMenu(); });
$("#homeBtn").onclick = () => showView("ask");
const viewFromHash = () => {
  const h = location.hash.slice(1);
  if (LOADERS[h]) { if (!$("#view-" + h).classList.contains("active")) showView(h); }
  else if (!$("#view-ask").classList.contains("active")) showView("ask");
};
addEventListener("hashchange", viewFromHash);
if (location.hash.length > 1 && LOADERS[location.hash.slice(1)]) showView(location.hash.slice(1));

/* ── keyboard ──────────────────────────────────────────────────────────── */
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); showView("ask"); $("#q").focus(); $("#q").select(); }
  if (e.key === "Escape") {
    if (!$("#docModal").hidden) { $("#docModal").hidden = true; return; }
    if (!menu.hidden) { closeMenu(); return; }
    if (!$("#view-ask").classList.contains("active")) { showView("ask"); return; }
    if (typing) e.target.blur();
  }
});

/* ── header strip ──────────────────────────────────────────────────────── */
api("/api/stats").then((s) => {
  $("#provider").textContent = `${s.models.resolved_answer || s.models.answer} · ${s.documents.canonical} docs · ${s.chunks.total} chunks`;
}).catch(() => { $("#provider").textContent = MOCK ? "demo data" : "api offline"; });

/* ══ ASK ════════════════════════════════════════════════════════════════ */
const hero = $("#hero"), results = $("#results");
let pipeline = null, inflight = null;

$("#examples").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $("#q").value = b.textContent; $("#askForm").requestSubmit();
};
$("#newQ").onclick = () => {
  inflight?.abort();
  results.hidden = true; hero.classList.remove("gone");
  $("#q").value = ""; $("#q").focus();
};
$("#askForm").onsubmit = (e) => { e.preventDefault(); ask($("#q").value.trim()); };

async function ask(question) {
  if (!question) return;
  inflight?.abort();
  const ac = new AbortController(); inflight = ac;

  hero.classList.add("gone");
  results.hidden = false;
  $("#askedText").textContent = question;
  $("#answerSlot").innerHTML = "";
  $("#traceSlot").innerHTML = "";
  $("#sources").innerHTML = `<div class="side-empty">Sources appear here as the pipeline finds them.</div>`;
  $("#sideHead").hidden = true; $("#srcCount").textContent = "";
  pipeline?.destroy();
  $("#pipelineSlot").innerHTML = "";
  pipeline = new Pipeline($("#pipelineSlot"));

  const btn = $("#askBtn"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>asking';
  let finished = false;

  const onEvent = (type, data) => {
    if (type === "final") { finished = true; pipeline.complete(data); renderResult(data); }
    else pipeline.onEvent(type, data);
  };

  try {
    if (MOCK) await mockStream(question, onEvent, ac.signal);
    else await streamAsk("/ask/stream", question, onEvent, ac.signal);
    if (!finished) throw new Error("stream ended without a final answer");
  } catch (err) {
    if (ac.signal.aborted) { btn.disabled = false; btn.textContent = "Ask"; return; }
    // ── fallback: the non-streaming endpoint ──────────────────────────
    pipeline.onEvent("note", { text: `Live stream unavailable (${err.message}). Falling back to POST /ask — same pipeline, reported after the fact.` });
    try {
      const r = await api("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }), signal: ac.signal });
      replaySteps(r);
      pipeline.complete(r);
      renderResult(r);
    } catch (e2) {
      if (!ac.signal.aborted) { pipeline.onEvent("error", { message: e2.message }); pipeline.complete(null); renderError(e2.message); }
    }
  }
  btn.disabled = false; btn.textContent = "Ask";
}

/* /ask returns steps[] (spec) — replay them into the panel so the trace is the same */
function replaySteps(r) {
  const steps = Array.isArray(r?.steps) ? r.steps : Array.isArray(r?.trace?.steps) ? r.trace.steps : null;
  if (steps?.length) {
    for (const s of steps) {
      if (s.type === "note" || s.text) { pipeline.onEvent("note", { text: s.text }); continue; }
      if (s.tool) {
        pipeline.onEvent("stage", { id: s.stage || "search", label: s.label, status: "start" });
        pipeline.onEvent("tool_call", { tool: s.tool, args: s.args, label: s.label });
        pipeline.onEvent("tool_result", { tool: s.tool, summary: s.summary, ms: s.ms, items: s.items });
        pipeline.onEvent("stage", { id: s.stage || "search", status: "done", ms: s.ms });
      } else {
        pipeline.onEvent("stage", { id: s.id || s.stage || "plan", label: s.label, status: "start" });
        pipeline.onEvent("stage", { id: s.id || s.stage || "plan", status: s.status === "skip" ? "skip" : "done", ms: s.ms, detail: s.detail });
      }
    }
    return;
  }
  // no steps[] — synthesise the classic retrieve → answer → gate trace
  const t = r?.trace || {};
  pipeline.onEvent("stage", { id: "search", label: "Hybrid retrieval (BM25 + vector)", status: "start" });
  pipeline.onEvent("tool_call", { tool: "search_corpus", args: { query: t.fts_query, vector: t.vector_used ? "on" : "off" }, label: "search_corpus" });
  pipeline.onEvent("tool_result", {
    tool: "search_corpus", ms: null, summary: `${t.candidates?.length || 0} candidates, ${t.selected?.length || 0} to the model`,
    items: (r.sources || []).map((s) => ({ n: s.n, title: s.title, url: s.url, domain: s.domain, date: s.effective_date || s.published_at, score: s.score })),
  });
  pipeline.onEvent("stage", { id: "search", status: "done", ms: null });
  if (t.facts?.length) {
    pipeline.onEvent("stage", { id: "facts", label: "Reading the fact ledger", status: "start" });
    pipeline.onEvent("tool_call", { tool: "fact_history", args: { keys: [...new Set(t.facts.map((f) => f.key))].join(",") }, label: "fact_history" });
    pipeline.onEvent("tool_result", { tool: "fact_history", ms: null, summary: `${t.facts.length} rows`, items: t.facts.map((f) => ({ key: f.key, value: f.value, as_of: f.as_of, url: f.url })) });
    pipeline.onEvent("stage", { id: "facts", status: "done", ms: null });
  }
  pipeline.onEvent("stage", { id: "answer", label: "Drafting the answer", status: t.model ? "start" : "skip", ms: 0 });
  if (t.model) pipeline.onEvent("stage", { id: "answer", status: "done", ms: t.latency_ms, detail: { model: t.model, tokens_in: t.usage?.input, tokens_out: t.usage?.output } });
  pipeline.onEvent("stage", { id: "verify", label: "Checking the gates", status: "start" });
  pipeline.onEvent("stage", { id: "verify", status: "done", ms: null, detail: { gate: r.gate, cited: (r.sources || []).map((s) => s.n).join(", ") || "none" } });
}

/* ── the answer ────────────────────────────────────────────────────────── */
const GATES = {
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

function renderResult(r) {
  if (!r) return;
  const ok = r.status === "answered";
  $("#answerSlot").innerHTML = ok ? answeredCard(r) : idkCard(r);
  renderSources(r.sources || []);
  renderTrace(r);
  wireCitations();
  $$(".try-list button", $("#answerSlot")).forEach((b) => b.onclick = () => {
    if (b.dataset.view) showView(b.dataset.view); else { $("#q").value = r.question || ""; showView("ask"); $("#q").focus(); }
  });
}

function answeredCard(r) {
  const meta = [
    `<span class="badge ok"><span class="dot"></span>answered</span>`,
    r.as_of ? `<span class="pill key">as of ${esc(r.as_of)}</span>` : `<span class="pill quiet">undated</span>`,
    r.mode ? `<span class="pill">${esc(r.mode)}</span>` : "",
    `<span class="pill">confidence ${pct(r.confidence)}</span>`,
    `<span class="pill quiet">${fmt$(r.trace?.cost_usd)} · ${fmtMs(r.trace?.latency_ms)}</span>`,
    r.trace?.model ? `<span class="pill quiet">${esc(r.trace.model)}</span>` : "",
  ].filter(Boolean).join("");
  return `<article class="answer-card"><div class="strip"></div><div class="answer-body">
    <div class="answer-meta">${meta}</div>
    <div class="answer-text">${citeUp(r.answer)}</div>
  </div></article>`;
}

function idkCard(r) {
  const g = GATES[r.gate] || GATES.none;
  const meta = [
    `<span class="badge idk"><span class="dot"></span>no reliable answer</span>`,
    `<span class="pill key">gate: ${esc(r.gate || "none")}</span>`,
    r.mode ? `<span class="pill">${esc(r.mode)}</span>` : "",
    `<span class="pill quiet">${fmt$(r.trace?.cost_usd)} · ${fmtMs(r.trace?.latency_ms)}</span>`,
  ].join("");
  return `<article class="answer-card is-idk"><div class="strip"></div><div class="idk-panel">
    <div class="answer-meta">${meta}</div>
    <h3 class="idk-title">${esc(g.title)}</h3>
    ${r.answer ? `<div class="idk-said">${esc(r.answer)}</div>` : ""}
    <div class="gate-box">
      <span class="gk">why</span><span class="gv">${esc(g.what)}</span>
      <span class="gk">not</span><span class="gv">No answer was fabricated, and no source was cited that did not exist.</span>
    </div>
    <div class="try-list"><span class="tl-h">what to try</span>
      ${g.tries.map(([k, v], i) => `<button type="button" ${i === 1 || i === 2 ? 'data-view="settings"' : ""}><span class="k">${esc(k)}</span>${esc(v)}</button>`).join("")}
    </div>
  </div></article>`;
}

function renderError(msg) {
  $("#answerSlot").innerHTML = `<article class="answer-card is-err"><div class="strip"></div><div class="idk-panel">
    <div class="answer-meta"><span class="badge err"><span class="dot"></span>request failed</span></div>
    <h3 class="idk-title">The request did not complete</h3>
    <div class="gate-box"><span class="gk">error</span><span class="gv">${esc(msg)}</span>
    <span class="gk">note</span><span class="gv">Neither the stream nor the plain endpoint answered. This says nothing about the corpus.</span></div>
  </div></article>`;
}

const citeUp = (t) => esc(t).replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, list) =>
  list.split(/\s*,\s*/).map((n) => `<span class="cite" data-n="${n}">${n}</span>`).join(""));

function renderSources(sources) {
  $("#sideHead").hidden = false;
  $("#srcCount").textContent = sources.length ? `${sources.length} cited` : "none";
  if (!sources.length) { $("#sources").innerHTML = `<div class="side-empty">Nothing was cited — no source cleared the evidence bar.</div>`; return; }
  $("#sources").innerHTML = sources.map((s, i) => `
    <article class="source t${s.tier}" id="src-${s.n}" style="animation-delay:${i * 35}ms">
      <div class="st"><span class="n">[${s.n}]</span><span class="ttl">${esc(s.title || s.url)}</span></div>
      <div class="m">
        ${tierBadge(s.tier)}<span>${esc(s.domain || domainOf(s.url))}</span>
        <span>${s.date_kind === "live" ? `<span class="live-dot">●</span> live page · fetched ${esc(s.effective_date || "")}`
              : s.published_at ? "published " + esc(s.published_at) : "undated"}</span>
        ${s.kind === "fact" ? "<span>fact ledger</span>" : ""}
      </div>
      <div class="quote">${esc(s.quote)}</div>
      <a class="lnk" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>
    </article>`).join("");
}

function wireCitations() {
  $$(".cite", $("#answerSlot")).forEach((c) => c.onclick = () => {
    const el = $("#src-" + c.dataset.n); if (!el) return;
    $$(".source").forEach((x) => x.classList.remove("hl"));
    $$(".cite").forEach((x) => x.classList.remove("on"));
    el.classList.add("hl"); c.classList.add("on");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function renderTrace(r) {
  const t = r.trace; if (!t?.candidates?.length) { $("#traceSlot").innerHTML = ""; return; }
  const max = Math.max(...t.candidates.map((c) => c.score), 1e-9);
  const selIds = new Map((t.selected || []).map((c) => [c.chunk_id, c.selected_by]));
  const meta = [
    `FTS <code>${esc(t.fts_query || "—")}</code>`, `vector ${t.vector_used ? "on" : "off"}`,
    `${t.candidates.length} candidates`, `${(t.selected || []).length} to the model`, `${(t.facts || []).length} fact rows`,
    `model ${t.model || "not called"}`,
    t.config ? `half-life ${t.config.ranking.recency_half_life_days}d · tiers ${Object.values(t.config.ranking.tier_weights).join("/")}` : "",
  ].filter(Boolean).map((x) => `<span class="pill quiet">${x}</span>`).join("");

  $("#traceSlot").innerHTML = `<details class="trace">
    <summary>Why these sources — retrieval trace</summary>
    <div class="trace-meta">${meta}</div>
    <div class="legend"><span class="sel"><i></i>sent to the model</span><span class="dd"><i></i>added for date diversity</span></div>
    <div class="tablewrap"><table><thead><tr>
      <th>#</th><th>source</th><th>date</th><th>tier</th><th>bm25</th><th>vec</th><th>rrf</th><th>recency</th><th>auth</th><th>score</th><th></th>
    </tr></thead><tbody>${t.candidates.slice(0, 40).map((c, i) => `
      <tr class="${selIds.get(c.chunk_id) === "date-diverse" ? "dd" : selIds.has(c.chunk_id) ? "selected" : ""}">
        <td class="num">${i + 1}</td>
        <td><a href="#" class="doclink" data-doc="${c.doc_id}">${esc((c.title || c.url).slice(0, 64))}</a>
            <div class="subtle">${esc(domainOf(c.url))}${c.ai_directed ? " · AI-directed page" : ""}</div></td>
        <td class="num">${c.effective_date || "—"}${c.date_kind === "live" ? '<div class="subtle">live</div>' : ""}</td>
        <td>${tierBadge(c.tier)}</td>
        <td class="num">${c.bm25_rank ?? "—"}</td>
        <td class="num">${c.vec_rank ?? "—"}${c.cosine != null ? `<div class="subtle">${c.cosine}</div>` : ""}</td>
        <td class="num">${c.rrf}</td><td class="num">${c.recency}</td><td class="num">${c.authority}</td>
        <td class="num"><span class="bar" style="width:${Math.round(54 * c.score / max)}px"></span>${c.score}</td>
        <td class="subtle">${selIds.get(c.chunk_id) === "date-diverse" ? "date-diverse" : selIds.has(c.chunk_id) ? "→ model" : ""}</td>
      </tr>`).join("")}</tbody></table></div>
    ${(t.facts || []).length ? `<h3 class="h">Fact ledger rows handed to the model</h3>
      <div class="tablewrap"><table><thead><tr><th>key</th><th>value</th><th>as of</th><th>source</th></tr></thead><tbody>
      ${t.facts.map((f) => `<tr><td><code>${esc(f.key)}</code></td><td>${esc(f.value)}</td><td class="num">${f.as_of || "—"}</td>
        <td>${tierBadge(f.tier)} <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(domainOf(f.url))}</a></td></tr>`).join("")}
      </tbody></table></div>` : ""}
  </details>`;
  wireDocLinks($("#traceSlot"));
}

/* ══ FACTS ══════════════════════════════════════════════════════════════ */
async function loadFacts() {
  const rows = await api("/api/facts").catch(() => []);
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  $("#factKey").innerHTML = keys.map((k) => `<option ${k === "networks_supported" ? "selected" : ""}>${esc(k)}</option>`).join("");
  const dateLabel = (s) => ({ text: "date in text", document: "document date", "live-page": "live page, fetched" })[s] || "document date";
  const draw = () => {
    const k = $("#factKey").value;
    const groups = [];
    for (const f of rows.filter((r) => r.key === k)) {
      const gk = `${f.value.toLowerCase()}|${(f.as_of || "").slice(0, 4)}`;
      let g = groups.find((x) => x.k === gk);
      if (!g) { g = { k: gk, first: f, items: [] }; groups.push(g); }
      g.items.push(f);
    }
    $("#factTimeline").innerHTML = groups.map(({ first: f, items }) => `
      <div class="tl t${f.tier}">
        <div class="d">${esc(f.as_of || "undated")}<small>${dateLabel(f.as_of_source)}</small></div>
        <div>
          <div class="v">${esc(f.value)} ${tierBadge(f.tier)}
            ${items.length > 1 ? `<span class="pill quiet">${items.length} sources</span>` : ""}
            ${f.ai_directed ? '<span class="pill quiet">AI-directed page</span>' : ""}
            ${f.flags ? `<span class="pill" style="color:var(--err)">${esc(f.flags)}</span>` : ""}</div>
          <div class="q">“${esc(f.quote)}”</div>
          <div class="s">${items.slice(0, 4).map((i) => `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc((i.title || i.url).slice(0, 62))}</a> · <a href="#" class="doclink" data-doc="${i.doc_id}">doc ${i.doc_id}</a>`).join("<br>")}${items.length > 4 ? `<br><span class="dim">+${items.length - 4} more</span>` : ""}</div>
        </div>
      </div>`).join("") || '<div class="empty">No rows for this key.</div>';
    wireDocLinks($("#factTimeline"));
  };
  $("#factKey").onchange = draw; draw();
}

/* ══ CORPUS ═════════════════════════════════════════════════════════════ */
async function loadCorpus() {
  const s = await api("/api/stats"); const d = s.documents;
  $("#statTiles").innerHTML = [
    ["canonical documents", d.canonical], ["fetched incl. aliases", d.ok], ["duplicates / aliases", d.aliases], ["dropped at crawl", d.dropped],
    ["with a publication date", `${d.dated} · ${Math.round(100 * d.dated / Math.max(d.canonical, 1))}%`], ["AI-directed pages", d.ai_directed],
    ["chunks", `${s.chunks.total}`], ["embedded", `${s.chunks.embedded}`],
    ["AI sentences removed", `${s.instructions.sentences}`], ["facts in ledger", `${s.facts.total}`],
    ["fact keys", s.facts.keys], ["total spent", fmt$(s.cost.reduce((a, r) => a + r.cost_usd, 0))],
  ].map(([l, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join("");
  $("#domainTable tbody").innerHTML = s.by_domain.map((r) => `<tr><td>${esc(r.domain)}</td><td>${tierBadge(r.tier)}</td><td class="num">${r.docs}</td><td class="num">${r.aliases}</td><td class="num">${r.oldest || "—"}</td><td class="num">${r.newest || "—"}</td></tr>`).join("");
  const maxY = Math.max(...s.by_year.map((y) => y.docs), 1);
  $("#yearBars").innerHTML = s.by_year.map((y) => `<div class="b" style="height:${Math.max(4, Math.round(100 * y.docs / maxY))}%"><span>${y.docs}</span><i>${y.year}</i></div>`).join("");
  $("#dedupSummary").innerHTML = `<p class="dim" style="font-size:13px;margin-bottom:10px">${d.aliases} aliases in clusters, by method: ${s.dedup.map((m) => `<code>${m.method}</code> ${m.n}${m.avg_similarity ? ` (avg sim ${m.avg_similarity})` : ""}`).join(", ") || "none"}</p>`;
  const clusters = await api("/api/dedup");
  $("#dedupTable tbody").innerHTML = clusters.map((c) => `<tr><td><a href="${esc(c.alias_url)}" target="_blank" rel="noopener">${esc(c.alias_url.replace(/^https?:\/\//, "").slice(0, 54))}</a></td><td><a href="${esc(c.canonical_url)}" target="_blank" rel="noopener">${esc(c.canonical_url.replace(/^https?:\/\//, "").slice(0, 54))}</a></td><td><code>${esc(c.method)}</code></td><td class="num">${c.similarity ?? ""}</td></tr>`).join("");
  $("#droppedTable tbody").innerHTML = s.dropped.map((r) => `<tr><td>${esc(r.reason)}</td><td class="num">${r.n}</td></tr>`).join("");
  const drawDocs = async () => {
    const docs = await api("/api/docs?q=" + encodeURIComponent($("#docSearch").value));
    $("#docTable tbody").innerHTML = docs.map((x) => `<tr>
      <td class="num"><a href="#" class="doclink" data-doc="${x.id}">${x.id}</a></td>
      <td>${esc((x.title || x.url).slice(0, 78))}<div class="subtle">${esc(x.url.slice(0, 88))}</div></td>
      <td>${esc(x.domain)}</td><td>${tierBadge(x.tier)}</td><td class="num">${x.published_at || "—"}</td><td class="num">${x.text_chars ?? ""}</td>
      <td class="subtle">${x.status === "dropped" ? "dropped: " + esc(x.drop_reason) : ""}${x.duplicate_of ? "alias of " + x.duplicate_of : ""}${x.ai_directed ? " AI-directed" : ""}</td></tr>`).join("");
    wireDocLinks($("#docTable"));
  };
  let tmr; $("#docSearch").oninput = () => { clearTimeout(tmr); tmr = setTimeout(drawDocs, 250); };
  drawDocs();
}

/* ══ INSTRUCTIONS ═══════════════════════════════════════════════════════ */
async function loadInstructions() {
  const rows = await api("/api/instructions");
  const byDoc = new Map();
  rows.forEach((r) => { if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, { ...r, list: [] }); byDoc.get(r.doc_id).list.push(r); });
  $("#instrSummary").textContent = `${rows.length} sentences in ${byDoc.size} documents`;
  $("#instrList").innerHTML = [...byDoc.values()].map((d) => `
    <div class="instr">
      <div class="u">${d.ai_directed ? '<span class="pill quiet">whole page flagged AI-directed</span> ' : ""}<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title || d.url)}</a> · <a href="#" class="doclink" data-doc="${d.doc_id}">doc ${d.doc_id}</a></div>
      ${d.list.map((i) => `<div class="s">“${esc(i.sentence)}”</div>`).join("")}
    </div>`).join("") || '<div class="empty">None found.</div>';
  wireDocLinks($("#instrList"));
}

/* ══ EVAL ═══════════════════════════════════════════════════════════════ */
async function loadEval() {
  const [run, cost] = await Promise.all([api("/api/eval"), api("/api/cost")]);
  if (!run) $("#evalTiles").innerHTML = '<div class="empty">No eval run yet — <code>npm run eval</code>.</div>';
  else {
    const m = run.metrics;
    $("#evalTiles").innerHTML = [
      ["accuracy strict", pct(m.accuracy_strict)], ["accuracy lenient", pct(m.accuracy_lenient)],
      ["successful", m.successful], ["failed", m.failed], ["invented a fact", m.hallucinated],
      ["abstained ok / wrongly", `${m.abstained_correctly} / ${m.abstained_wrongly}`],
      ["avg cost / question", fmt$(m.avg_cost_per_question_usd)], ["avg latency", fmtMs(m.avg_latency_ms)],
    ].map(([l, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join("");
    const cls = (v) => v === "correct" || v === "abstained_correctly" ? "v-ok" : v === "partially_correct" ? "v-part" : "v-bad";
    $("#evalTable tbody").innerHTML = run.rows.map((r) => {
      const v = r.human_verdict || r.verdict;
      return `<tr><td class="num">${r.id}${r.trap ? " ⚠" : ""}</td><td>${esc(r.question)}</td><td class="dim">${esc(r.reference)}</td>
        <td>${esc(r.system_answer)}${r.as_of ? `<div class="subtle">as of ${r.as_of}</div>` : ""}</td>
        <td class="${cls(v)}">${esc(v)}${r.human_verdict ? " (human)" : ""}<div class="subtle" style="font-weight:400">${esc(r.reason)}</div></td></tr>`;
    }).join("");
  }
  $("#costBox").textContent = JSON.stringify(cost, null, 2);
}

/* ══ SETTINGS ═══════════════════════════════════════════════════════════ */
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
let cfgBaseline = {};
async function loadSettings() {
  const cfg = await api("/api/config");
  cfgBaseline = {};
  $$("[data-path]").forEach((el) => {
    const v = getPath(cfg, el.dataset.path);
    el.value = Array.isArray(v) ? v.join(", ") : v ?? "";
    cfgBaseline[el.dataset.path] = el.value;
    el.classList.remove("dirty");
    el.oninput = el.onchange = () => el.classList.toggle("dirty", el.value !== cfgBaseline[el.dataset.path]);
  });
}
$("#saveCfg").onclick = async () => {
  const patch = {};
  $$("[data-path]").forEach((el) => {
    const [sec, ...rest] = el.dataset.path.split(".");
    let v = el.value;
    if (el.dataset.list === "1") v = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (el.dataset.list === "num") v = v.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    else if (el.type === "number") v = v === "" ? null : Number(v);
    else if (v === "true" || v === "false") v = v === "true";
    patch[sec] ??= {};
    if (rest.length === 2) { patch[sec][rest[0]] ??= {}; patch[sec][rest[0]][rest[1]] = v; } else patch[sec][rest[0]] = v;
  });
  const cur = await api("/api/config");
  if (patch.ranking?.tier_weights) patch.ranking.tier_weights = { ...cur.ranking.tier_weights, ...patch.ranking.tier_weights };
  await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  await loadSettings();
  $("#cfgMsg").textContent = "applied — the next question uses these settings";
  setTimeout(() => $("#cfgMsg").textContent = "", 3500);
};
$("#resetCfg").onclick = async () => { await api("/api/config", { method: "DELETE" }); await loadSettings(); $("#cfgMsg").textContent = "reset to config/kb.yaml"; setTimeout(() => $("#cfgMsg").textContent = "", 3500); };

/* ══ DOC MODAL ══════════════════════════════════════════════════════════ */
function wireDocLinks(scope) {
  $$(".doclink", scope).forEach((a) => a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.doc); });
}
async function openDoc(id) {
  const d = await api("/api/doc/" + id);
  $("#docContent").innerHTML = `
    <h3 style="font-family:var(--serif);font-size:25px;font-weight:500;letter-spacing:-.015em;margin-bottom:8px;padding-right:30px">${esc(d.title || d.url)}</h3>
    <div class="m" style="display:flex;gap:8px;flex-wrap:wrap;font-family:var(--mono);font-size:11.5px;color:var(--dim);align-items:center">
      ${tierBadge(d.tier)}<span>${esc(d.domain)}</span><span>${esc(d.category)}</span>
      <span>published ${d.published_at || "unknown"}${d.date_source ? ` (${esc(d.date_source)})` : ""}</span>
      <span>${d.text_chars} chars</span>${d.ai_directed ? '<span style="color:var(--idk)">AI-directed page</span>' : ""}
      ${d.duplicate_of ? `<span>alias of doc ${d.duplicate_of}</span>` : ""}
    </div>
    <div style="font-size:12.5px;margin:10px 0;font-family:var(--mono)"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>
      ${d.final_url && d.final_url !== d.url ? `<br><span class="dim">→ redirected to</span> ${esc(d.final_url)}` : ""}
      ${d.canonical_url ? `<br><span class="dim">canonical:</span> ${esc(d.canonical_url)}` : ""}</div>
    ${d.aliases.length ? `<div style="font-size:12.5px"><b>Also found at:</b><br>${d.aliases.map((a) => `${esc(a.url)} <code>${esc(a.dedup_method)}</code>`).join("<br>")}</div>` : ""}
    ${d.instructions.length ? `<div style="margin-top:12px"><b style="font-size:13px">AI-directed sentences removed (${d.instructions.length})</b>${d.instructions.slice(0, 8).map((s) => `<div class="instr" style="margin-top:6px"><div class="s">“${esc(s)}”</div></div>`).join("")}</div>` : ""}
    ${d.facts.length ? `<div style="font-size:12.5px;margin-top:12px"><b>Facts extracted:</b> ${d.facts.map((f) => `<code>${esc(f.key)}</code>=${esc(f.value)}${f.as_of ? ` (${f.as_of})` : ""}`).join(" · ")}</div>` : ""}
    <h4 class="h">Indexed text</h4><div class="doc-text">${esc(d.text)}</div>`;
  $("#docModal").hidden = false;
}
$("#docClose").onclick = () => $("#docModal").hidden = true;
$("#docModal").onclick = (e) => { if (e.target.id === "docModal") $("#docModal").hidden = true; };

/* focus the input on load */
if ($("#view-ask").classList.contains("active")) $("#q").focus();
