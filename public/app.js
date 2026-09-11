/* Everstake KB — single-file UI, no build step. Talks only to the JSON API. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (path, opts) => { const r = await fetch(path, opts); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt$ = (x) => x == null ? "" : x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(3)}`;
const tierBadge = (t) => `<span class="tier t${t}">T${t}</span>`;
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

// ---------- theme & tabs ----------
const root = document.documentElement;
try { if (localStorage.theme) root.dataset.theme = localStorage.theme; } catch {}
$("#theme").onclick = () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.theme = root.dataset.theme; } catch {} };
const loaded = {};
$("#tabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  location.hash = b.dataset.tab;
  if (!loaded[b.dataset.tab]) { loaded[b.dataset.tab] = true; ({ facts: loadFacts, corpus: loadCorpus, instructions: loadInstructions, eval: loadEval, settings: loadSettings })[b.dataset.tab]?.(); }
};
if (location.hash.length > 1) $(`#tabs button[data-tab="${location.hash.slice(1)}"]`)?.click();

api("/api/stats").then((s) => { $("#provider").textContent = `${s.models.answer} · ${s.documents.canonical} docs · llm: ${s.provider.llm}`; }).catch(() => {});

// ---------- ASK ----------
$("#examples").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; $("#q").value = b.textContent; $("#askForm").requestSubmit(); };
$("#askForm").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("#q").value.trim(); if (!question) return;
  const btn = $("#askBtn"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>thinking';
  $("#answer").classList.remove("hidden");
  $("#answerText").innerHTML = '<span class="muted">retrieving, ranking, asking the model…</span>';
  $("#sources").innerHTML = ""; $("#traceTable tbody").innerHTML = ""; $("#factsUsed").innerHTML = "";
  try { render(await api("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) })); }
  catch (err) { $("#answerText").innerHTML = `<span class="v-bad">Error: ${esc(err.message)}</span>`; }
  btn.disabled = false; btn.textContent = "Ask";
};

function render(r) {
  const ok = r.status === "answered";
  const sb = $("#statusBadge"); sb.className = "badge " + (ok ? "ok" : "idk"); sb.textContent = ok ? "answered" : "no reliable answer";
  $("#modeBadge").textContent = r.mode ? r.mode : ""; $("#modeBadge").classList.toggle("hidden", !r.mode);
  $("#asOf").textContent = r.as_of ? "as of " + r.as_of : ""; $("#asOf").classList.toggle("hidden", !r.as_of);
  $("#confidence").textContent = ok ? "confidence " + Math.round(r.confidence * 100) + "%" : ""; $("#confidence").classList.toggle("hidden", !ok);
  $("#gate").textContent = r.gate !== "none" ? "gate: " + r.gate : ""; $("#gate").classList.toggle("hidden", r.gate === "none");
  $("#costPill").textContent = `${fmt$(r.trace.cost_usd)} · ${r.trace.latency_ms} ms` + (r.trace.usage ? ` · ${r.trace.usage.input}→${r.trace.usage.output} tok` : "");
  $("#answerText").innerHTML = esc(r.answer).replace(/\[(\d+)\]/g, (_, n) => `<span class="cite" data-n="${n}">${n}</span>`);
  $("#srcCount").textContent = r.sources.length ? `(${r.sources.length} cited)` : ok ? "" : "(none — nothing cited)";
  $("#sources").innerHTML = r.sources.map((s) => `
    <div class="source" id="src-${s.n}">
      <div><span class="n">[${s.n}]</span> <span class="t">${esc(s.title || s.url)}</span></div>
      <div class="m">${tierBadge(s.tier)} <span>${esc(s.domain || domain(s.url))}</span> <span>${s.published_at ? "published " + s.published_at : s.date_kind === "live" ? "live page · fetched " + s.effective_date : "undated"}</span> <span>${s.kind === "fact" ? "fact ledger" : "chunk"}</span></div>
      <div class="quote">${esc(s.quote)}</div>
      <div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
    </div>`).join("");
  $$(".cite").forEach((c) => c.onclick = () => { const el = $("#src-" + c.dataset.n); if (!el) return; $$(".source").forEach((x) => x.classList.remove("hl")); el.classList.add("hl"); el.scrollIntoView({ behavior: "smooth", block: "center" }); });

  const t = r.trace;
  $("#traceMeta").innerHTML = [
    `FTS query: <code>${esc(t.fts_query || "—")}</code>`, `vector search: ${t.vector_used ? "on" : "off (BM25 only)"}`,
    `candidates: ${t.candidates.length}`, `selected: ${t.selected.length}`, `fact rows: ${t.facts.length}`, `model: ${t.model || "not called"}`,
    `half-life ${t.config.ranking.recency_half_life_days}d · tiers ${JSON.stringify(t.config.ranking.tier_weights)}`,
  ].map((x) => `<span>${x}</span>`).join("");
  const max = Math.max(...t.candidates.map((c) => c.score), 1e-9);
  const selIds = new Map(t.selected.map((c) => [c.chunk_id, c.selected_by]));
  $("#traceTable tbody").innerHTML = t.candidates.slice(0, 40).map((c, i) => `
    <tr class="${selIds.has(c.chunk_id) ? (selIds.get(c.chunk_id) === "date-diverse" ? "dd" : "selected") : ""}">
      <td class="num">${i + 1}</td>
      <td><a href="#" data-doc="${c.doc_id}" class="doclink">${esc((c.title || c.url).slice(0, 70))}</a><div class="muted" style="font-size:11px">${esc(domain(c.url))}${c.ai_directed ? " · AI-directed page" : ""}</div></td>
      <td class="num">${c.effective_date ? c.effective_date + (c.date_kind === "live" ? '<div class="muted">live page</div>' : "") : "—"}</td><td>${tierBadge(c.tier)}</td>
      <td class="num">${c.bm25_rank ?? "—"}</td><td class="num">${c.vec_rank ?? "—"}${c.cosine != null ? `<div class="muted">${c.cosine}</div>` : ""}</td>
      <td class="num">${c.rrf}</td><td class="num">${c.recency}</td><td class="num">${c.authority}</td>
      <td class="num"><span class="bar" style="width:${Math.round(60 * c.score / max)}px"></span>${c.score}</td>
      <td class="muted" style="font-size:11px">${selIds.get(c.chunk_id) === "date-diverse" ? "date-diverse" : selIds.has(c.chunk_id) ? "→ model" : ""}</td>
    </tr>`).join("");
  $("#factsUsed").innerHTML = t.facts.length ? `<h3 class="h">Fact ledger rows handed to the model</h3><div class="tablewrap"><table><thead><tr><th>key</th><th>value</th><th>as of</th><th>source</th></tr></thead><tbody>${t.facts.map((f) => `<tr><td><code>${esc(f.key)}</code></td><td>${esc(f.value)}</td><td class="num">${f.as_of || "—"}</td><td>${tierBadge(f.tier)} <a href="${esc(f.url)}" target="_blank">${esc(domain(f.url))}</a></td></tr>`).join("")}</tbody></table></div>` : "";
  $$(".doclink").forEach((a) => a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.doc); });
}

// ---------- FACTS ----------
async function loadFacts() {
  const rows = await api("/api/facts");
  const keys = [...new Set(rows.map((r) => r.key))].sort();
  $("#factKey").innerHTML = keys.map((k) => `<option ${k === "networks_supported" ? "selected" : ""}>${k}</option>`).join("");
  const dateLabel = (s) => ({ text: "date in text", document: "doc date", "live-page": "live page, fetched" })[s] || "doc date";
  const draw = () => {
    const k = $("#factKey").value;
    const list = rows.filter((r) => r.key === k);
    // group identical values that repeat across many pages (e.g. "130+" on 40 pages) → one row per value+year
    const groups = [];
    for (const f of list) {
      const gk = `${f.value.toLowerCase()}|${(f.as_of || "").slice(0, 4)}`;
      let g = groups.find((x) => x.k === gk);
      if (!g) { g = { k: gk, first: f, items: [] }; groups.push(g); }
      g.items.push(f);
    }
    $("#factTimeline").innerHTML = groups.map(({ first: f, items }) => `
      <div class="tl t${f.tier}">
        <div class="d">${f.as_of || "undated"}<div class="muted" style="font-size:11px">${dateLabel(f.as_of_source)}</div></div>
        <div><div class="v">${esc(f.value)} ${tierBadge(f.tier)} ${items.length > 1 ? `<span class="pill muted">${items.length} sources</span>` : ""} ${f.ai_directed ? '<span class="pill muted">AI-directed page</span>' : ""} ${f.flags ? `<span class="pill" style="color:var(--bad)">${esc(f.flags)}</span>` : ""}</div>
          <div class="q">“${esc(f.quote)}”</div>
          <div class="s">${items.slice(0, 4).map((i) => `<a href="${esc(i.url)}" target="_blank">${esc((i.title || i.url).slice(0, 60))}</a> · <a href="#" class="doclink" data-doc="${i.doc_id}">doc ${i.doc_id}</a>`).join("<br>")}${items.length > 4 ? `<br><span class="muted">+${items.length - 4} more</span>` : ""}</div></div>
      </div>`).join("") || '<p class="muted">no rows</p>';
    $$(".doclink", $("#factTimeline")).forEach((a) => a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.doc); });
  };
  $("#factKey").onchange = draw; draw();
}

// ---------- CORPUS ----------
async function loadCorpus() {
  const s = await api("/api/stats");
  const d = s.documents;
  $("#statTiles").innerHTML = [
    ["canonical documents", d.canonical], ["fetched (incl. aliases)", d.ok], ["duplicates / aliases", d.aliases], ["dropped at crawl", d.dropped],
    ["with a publication date", `${d.dated} (${Math.round(100 * d.dated / Math.max(d.canonical, 1))}%)`], ["AI-directed pages", d.ai_directed],
    ["chunks", `${s.chunks.total} (${s.chunks.embedded} embedded)`], ["AI-instruction sentences removed", `${s.instructions.sentences} in ${s.instructions.documents} docs`],
    ["facts in ledger", `${s.facts.total} (${s.facts.keys} keys, ${s.facts.malformed || 0} flagged)`], ["total spent", fmt$(s.cost.reduce((a, r) => a + r.cost_usd, 0))],
  ].map(([l, v]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join("");
  $("#domainTable tbody").innerHTML = s.by_domain.map((r) => `<tr><td>${esc(r.domain)}</td><td>${tierBadge(r.tier)}</td><td class="num">${r.docs}</td><td class="num">${r.aliases}</td><td class="num">${r.oldest || "—"}</td><td class="num">${r.newest || "—"}</td></tr>`).join("");
  const maxY = Math.max(...s.by_year.map((y) => y.docs), 1);
  $("#yearBars").innerHTML = s.by_year.map((y) => `<div class="b" style="height:${Math.round(100 * y.docs / maxY)}%"><span>${y.docs}</span><i>${y.year}</i></div>`).join("");
  $("#dedupSummary").innerHTML = `<p class="muted">${d.aliases} aliases in clusters, by method: ${s.dedup.map((m) => `<code>${m.method}</code> ${m.n}${m.avg_similarity ? ` (avg sim ${m.avg_similarity})` : ""}`).join(", ") || "none"}</p>`;
  const clusters = await api("/api/dedup");
  $("#dedupTable tbody").innerHTML = clusters.map((c) => `<tr><td><a href="${esc(c.alias_url)}" target="_blank">${esc(c.alias_url.replace(/^https?:\/\//, "").slice(0, 60))}</a></td><td><a href="${esc(c.canonical_url)}" target="_blank">${esc(c.canonical_url.replace(/^https?:\/\//, "").slice(0, 60))}</a></td><td><code>${c.method}</code></td><td class="num">${c.similarity ?? ""}</td></tr>`).join("");
  $("#droppedTable tbody").innerHTML = s.dropped.map((r) => `<tr><td>${esc(r.reason)}</td><td class="num">${r.n}</td></tr>`).join("");
  const drawDocs = async () => {
    const docs = await api("/api/docs?q=" + encodeURIComponent($("#docSearch").value));
    $("#docTable tbody").innerHTML = docs.map((x) => `<tr><td class="num"><a href="#" class="doclink" data-doc="${x.id}">${x.id}</a></td><td>${esc((x.title || x.url).slice(0, 80))}<div class="muted" style="font-size:11px">${esc(x.url.slice(0, 90))}</div></td><td>${esc(x.domain)}</td><td>${tierBadge(x.tier)}</td><td class="num">${x.published_at || "—"}</td><td class="num">${x.text_chars ?? ""}</td><td class="muted" style="font-size:11px">${x.status === "dropped" ? "dropped: " + esc(x.drop_reason) : ""}${x.duplicate_of ? "alias of " + x.duplicate_of : ""}${x.ai_directed ? " AI-directed" : ""}</td></tr>`).join("");
    $$(".doclink", $("#docTable")).forEach((a) => a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.doc); });
  };
  let tmr; $("#docSearch").oninput = () => { clearTimeout(tmr); tmr = setTimeout(drawDocs, 250); }; drawDocs();
}

// ---------- INSTRUCTIONS ----------
async function loadInstructions() {
  const rows = await api("/api/instructions");
  const byDoc = new Map();
  rows.forEach((r) => { if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, { ...r, list: [] }); byDoc.get(r.doc_id).list.push(r); });
  $("#instrSummary").textContent = `${rows.length} sentences in ${byDoc.size} documents`;
  $("#instrList").innerHTML = [...byDoc.values()].map((d) => `
    <div class="instr">
      <div class="u">${d.ai_directed ? '<span class="pill">whole page flagged AI-directed</span> ' : ""}<a href="${esc(d.url)}" target="_blank">${esc(d.title || d.url)}</a> · <a href="#" class="doclink" data-doc="${d.doc_id}">doc ${d.doc_id}</a></div>
      ${d.list.map((i) => `<div class="s">“${esc(i.sentence)}”</div>`).join("")}
    </div>`).join("") || '<p class="muted">none found</p>';
  $$(".doclink", $("#instrList")).forEach((a) => a.onclick = (e) => { e.preventDefault(); openDoc(a.dataset.doc); });
}

// ---------- EVAL ----------
async function loadEval() {
  const [run, cost] = await Promise.all([api("/api/eval"), api("/api/cost")]);
  if (!run) { $("#evalTiles").innerHTML = '<p class="muted">No eval run yet — <code>npm run eval</code>.</p>'; }
  else {
    const m = run.metrics;
    $("#evalTiles").innerHTML = [["accuracy (strict)", Math.round(m.accuracy_strict * 100) + "%"], ["accuracy (lenient)", Math.round(m.accuracy_lenient * 100) + "%"], ["successful", m.successful], ["failed", m.failed], ["invented a fact", m.hallucinated], ["abstained ok / wrongly", `${m.abstained_correctly} / ${m.abstained_wrongly}`], ["avg cost / question", fmt$(m.avg_cost_per_question_usd)], ["avg latency", m.avg_latency_ms + " ms"]]
      .map(([l, v]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
    const cls = (v) => v === "correct" || v === "abstained_correctly" ? "v-ok" : v === "partially_correct" ? "v-part" : "v-bad";
    $("#evalTable tbody").innerHTML = run.rows.map((r) => { const v = r.human_verdict || r.verdict; return `<tr><td class="num">${r.id}${r.trap ? " ⚠️" : ""}</td><td>${esc(r.question)}</td><td class="muted">${esc(r.reference)}</td><td>${esc(r.system_answer)}${r.as_of ? `<div class="muted">as of ${r.as_of}</div>` : ""}</td><td class="${cls(v)}">${v}${r.human_verdict ? " (human)" : ""}<div class="muted" style="font-weight:400;font-size:11px">${esc(r.reason)}</div></td></tr>`; }).join("");
  }
  $("#costBox").textContent = JSON.stringify(cost, null, 2);
}

// ---------- SETTINGS ----------
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
async function loadSettings() {
  const cfg = await api("/api/config");
  $$("[data-path]").forEach((el) => { const v = getPath(cfg, el.dataset.path); el.value = Array.isArray(v) ? v.join(", ") : v ?? ""; });
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
  // tier_weights is nested: merge with current so partial edits keep other tiers
  const cur = await api("/api/config");
  if (patch.ranking?.tier_weights) patch.ranking.tier_weights = { ...cur.ranking.tier_weights, ...patch.ranking.tier_weights };
  await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  $("#cfgMsg").textContent = "applied — next question uses these settings"; setTimeout(() => $("#cfgMsg").textContent = "", 3000);
};
$("#resetCfg").onclick = async () => { await api("/api/config", { method: "DELETE" }); loadSettings(); $("#cfgMsg").textContent = "reset to config/kb.yaml"; };

// ---------- DOC MODAL ----------
async function openDoc(id) {
  const d = await api("/api/doc/" + id);
  $("#docContent").innerHTML = `
    <h3 style="margin:0 0 6px">${esc(d.title || d.url)}</h3>
    <div class="muted" style="font-size:13px">${tierBadge(d.tier)} ${esc(d.domain)} · ${d.category} · published ${d.published_at || "unknown"}${d.date_source ? ` (${d.date_source})` : ""} · ${d.text_chars} chars${d.ai_directed ? " · <b>AI-directed page</b>" : ""}${d.duplicate_of ? ` · alias of doc ${d.duplicate_of}` : ""}</div>
    <div style="font-size:13px;margin:6px 0"><a href="${esc(d.url)}" target="_blank">${esc(d.url)}</a>${d.final_url && d.final_url !== d.url ? `<br><span class="muted">→ redirected to</span> ${esc(d.final_url)}` : ""}${d.canonical_url ? `<br><span class="muted">canonical:</span> ${esc(d.canonical_url)}` : ""}</div>
    ${d.aliases.length ? `<div style="font-size:13px"><b>Also found at:</b> ${d.aliases.map((a) => `${esc(a.url)} <code>${a.dedup_method}</code>`).join("<br>")}</div>` : ""}
    ${d.instructions.length ? `<div style="font-size:13px;margin-top:8px"><b>AI-directed sentences removed (${d.instructions.length}):</b>${d.instructions.slice(0, 8).map((s) => `<div class="muted">“${esc(s)}”</div>`).join("")}</div>` : ""}
    ${d.facts.length ? `<div style="font-size:13px;margin-top:8px"><b>Facts extracted:</b> ${d.facts.map((f) => `<code>${esc(f.key)}</code>=${esc(f.value)}${f.as_of ? ` (${f.as_of})` : ""}`).join(" · ")}</div>` : ""}
    <h4 class="h">Indexed text</h4><div class="doc-text">${esc(d.text)}</div>`;
  $("#docModal").classList.remove("hidden");
}
$("#docClose").onclick = () => $("#docModal").classList.add("hidden");
$("#docModal").onclick = (e) => { if (e.target.id === "docModal") $("#docModal").classList.add("hidden"); };
