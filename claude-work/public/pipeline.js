/* Live pipeline panel + SSE stream reader.
   Consumes the event contract from docs/agentic-spec.md:
     stage {id,label,status:start|done|skip,ms,detail}
     tool_call {step,tool,args,label}
     tool_result {step,tool,summary,ms,items[]}
     note {text}
     final <AskResult>   error {message}                                      */

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); } };
export const fmtMs = (ms) => ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
export const fmt$ = (x) => x == null ? "—" : x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(3)}`;

const STAGES = {
  plan:   { icon: "◇", label: "Planning the approach" },
  search: { icon: "⌕", label: "Searching the corpus" },
  facts:  { icon: "▤", label: "Reading the fact ledger" },
  live:   { icon: "⟲", label: "Checking the live page" },
  read:   { icon: "❐", label: "Reading a document" },
  answer: { icon: "✎", label: "Drafting the answer" },
  verify: { icon: "✓", label: "Verifying citations" },
};
const TOOL_ICON = { search_corpus: "⌕", fact_history: "▤", get_document: "❐", fetch_live_page: "⟲", everstake_live_data: "⇄", finish: "✓" };

/* ── SSE over POST ─────────────────────────────────────────────────────────
   fetch + ReadableStream (EventSource cannot POST). Yields {type, data}.   */
export async function streamAsk(url, question, onEvent, signal) {
  const res = await fetch(url, {
    method: "POST", signal,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok || !res.body) throw new Error(`stream unavailable (${res.status})`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) throw new Error("stream unavailable (not an event stream)");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      emit(frame, onEvent);
    }
  }
  if (buf.trim()) emit(buf, onEvent);
}

function emit(frame, onEvent) {
  let type = "message"; const dataLines = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return;
  let data; const text = dataLines.join("\n");
  try { data = JSON.parse(text); } catch { data = { text }; }
  onEvent(type, data);
}

/* ── the panel ─────────────────────────────────────────────────────────── */
export class Pipeline {
  constructor(mount) {
    this.mount = mount;
    this.steps = [];       // {key,id,icon,label,status,ms,t0,detail,calls[],notes[]}
    this.expanded = new Set();
    this.collapsed = false;
    this.toolCalls = 0;
    this.t0 = performance.now();
    this.finalSummary = null;
    this.el = null;
    this.tick = setInterval(() => this.paintTimers(), 120);
    this.render();
  }

  destroy() { clearInterval(this.tick); }

  /* one entry point for every stream event */
  onEvent(type, d = {}) {
    if (type === "stage") this.stage(d);
    else if (type === "tool_call") this.toolCall(d);
    else if (type === "tool_result") this.toolResult(d);
    else if (type === "note") this.note(d);
    else if (type === "error") this.fail(d.message || "stream error");
    if (type !== "final") this.render();
  }

  stage(d) {
    const meta = STAGES[d.id] || { icon: "•", label: d.id };
    if (d.status === "start") {
      this.closeOpen();
      this.steps.push({ key: `${d.id}-${this.steps.length}`, id: d.id, icon: meta.icon, label: d.label || meta.label, status: "run", t0: performance.now(), calls: [], notes: [], detail: d.detail || null });
      return;
    }
    const s = [...this.steps].reverse().find((x) => x.id === d.id && x.status === "run")
           || (this.steps.push({ key: `${d.id}-${this.steps.length}`, id: d.id, icon: meta.icon, label: d.label || meta.label, status: "run", t0: performance.now(), calls: [], notes: [], detail: null }), this.steps.at(-1));
    s.status = d.status === "skip" ? "skip" : "done";
    s.ms = d.ms === undefined ? Math.round(performance.now() - s.t0) : d.ms;
    if (d.label) s.label = d.label;
    if (d.detail) s.detail = { ...(s.detail || {}), ...d.detail };
  }

  current() {
    const open = [...this.steps].reverse().find((s) => s.status === "run");
    if (open) return open;
    // a tool call outside any stage → synthesise one
    this.steps.push({ key: `tool-${this.steps.length}`, id: "search", icon: "⌕", label: "Working", status: "run", t0: performance.now(), calls: [], notes: [] });
    return this.steps.at(-1);
  }

  toolCall(d) {
    this.toolCalls++;
    const s = this.current();
    s.calls.push({ tool: d.tool, args: d.args || null, label: d.label || "", t0: performance.now(), items: null, summary: null, ms: null });
    if (d.label) s.sub = d.label;
  }

  toolResult(d) {
    const s = this.current();
    const c = [...s.calls].reverse().find((x) => x.tool === d.tool && x.summary == null) || s.calls.at(-1);
    if (!c) { s.calls.push({ tool: d.tool, summary: d.summary, ms: d.ms, items: d.items || null }); return; }
    c.summary = d.summary ?? ""; c.ms = d.ms === undefined ? Math.round(performance.now() - c.t0) : d.ms; c.items = d.items || null;
    if (c.items?.length || (d.summary && d.summary.length)) this.expanded.add(s.key + "|" + s.calls.indexOf(c));
  }

  note(d) {
    if (!this.steps.length) { (this.prelude ??= []).push(d.text || ""); return; }
    this.steps.at(-1).notes.push(d.text || "");
  }

  fail(msg) { this.closeOpen("fail"); this.steps.push({ key: `err-${this.steps.length}`, id: "error", icon: "!", label: msg, status: "fail", ms: 0, calls: [], notes: [] }); }

  closeOpen(as = "done") {
    for (const s of this.steps) if (s.status === "run") { s.status = as; s.ms = Math.round(performance.now() - s.t0); }
  }

  /* called on `final` — collapse to a one-line summary */
  complete(result) {
    this.closeOpen();
    const ms = result?.trace?.latency_ms ?? Math.round(performance.now() - this.t0);
    const parts = [`${this.steps.length} step${this.steps.length === 1 ? "" : "s"}`];
    if (this.toolCalls) parts.push(`${this.toolCalls} tool call${this.toolCalls === 1 ? "" : "s"}`);
    parts.push(fmtMs(ms));
    if (result?.trace?.cost_usd != null) parts.push(fmt$(result.trace.cost_usd));
    if (result?.trace?.model) parts.push(result.trace.model);
    this.finalSummary = parts.join("  ·  ");
    this.collapsed = true;
    clearInterval(this.tick); this.tick = null;
    this.render();
  }

  /* ── rendering ─────────────────────────────────────────────────────── */
  render() {
    const running = this.steps.some((s) => s.status === "run");
    const head = `
      <div class="pipe-head">
        <span class="pipe-title">${running ? "pipeline · live" : "pipeline"}</span>
        <span class="pipe-sum">${this.finalSummary ? esc(this.finalSummary) : `<span class="js-elapsed">${fmtMs(performance.now() - this.t0)}</span>`}</span>
        <button class="pipe-toggle" type="button">${this.collapsed ? "expand ▾" : "collapse ▴"}</button>
      </div>`;
    const pre = (this.prelude || []).map((n) => `<div class="note" style="margin-left:0">${esc(n)}</div>`).join("");
    const body = `<div class="pipe-body">${pre}${this.steps.map((s) => this.step(s)).join("") || '<div class="step run"><span class="ic">◇</span><span class="lbl">Starting…</span><span class="ms"></span></div>'}</div>`;

    if (!this.el) {
      this.el = document.createElement("section");
      this.el.className = "pipe";
      this.mount.appendChild(this.el);
      this.el.addEventListener("click", (e) => {
        const t = e.target.closest(".pipe-toggle, .expand");
        if (!t) return;
        if (t.classList.contains("pipe-toggle")) this.collapsed = !this.collapsed;
        else { const k = t.dataset.k; this.expanded.has(k) ? this.expanded.delete(k) : this.expanded.add(k); }
        this.render();
      });
    }
    this.el.classList.toggle("collapsed", this.collapsed);
    this.el.innerHTML = head + body;
  }

  paintTimers() {
    if (!this.el) return;
    const g = this.el.querySelector(".js-elapsed");
    if (g) g.textContent = fmtMs(performance.now() - this.t0);
    for (const s of this.steps) {
      if (s.status !== "run") continue;
      const n = this.el.querySelector(`[data-ms="${s.key}"]`);
      if (n) n.textContent = fmtMs(performance.now() - s.t0);
    }
  }

  step(s) {
    const cls = s.status === "run" ? "run" : s.status === "skip" ? "skip" : s.status === "fail" ? "fail" : "done";
    const ic = s.status === "done" ? "✓" : s.status === "skip" ? "–" : s.icon;
    const ms = s.status === "run" ? `<span data-ms="${s.key}">${fmtMs(performance.now() - s.t0)}</span>`
             : s.status === "skip" ? "skipped" : fmtMs(s.ms);
    const sub = s.status === "run" && s.sub ? `<span class="sub">${esc(s.sub)}</span>` : "";
    const details = s.calls.map((c, i) => this.call(s, c, i)).join("");
    const notes = s.notes.map((n) => `<div class="note">${esc(n)}</div>`).join("");
    const stageDetail = s.detail ? this.detailBlock(s.detail, s.calls.length > 0) : "";
    return `<div class="step ${cls}">
      <span class="ic">${ic}</span>
      <span class="lbl"><b>${esc(s.label)}</b>${sub}</span>
      <span class="ms">${ms}</span>
      ${details || stageDetail ? `<div class="det">${details}${stageDetail}</div>` : ""}
    </div>${notes}`;
  }

  call(s, c, i) {
    const k = s.key + "|" + i;
    const open = this.expanded.has(k);
    const args = c.args ? Object.entries(c.args).filter(([, v]) => v != null && v !== "").map(([a, v]) => `<b>${esc(a)}</b>=${esc(Array.isArray(v) ? v.join(",") : v)}`).join("  ") : "";
    const head = `<div class="args"><span style="color:var(--accent)">${TOOL_ICON[c.tool] || "▸"}</span> <b>${esc(c.tool)}</b>${args ? "  " + args : ""}${c.summary != null ? `  →  ${esc(c.summary)}` : ' <span class="spin"></span>'}${c.ms != null ? `  <span style="opacity:.7">${fmtMs(c.ms)}</span>` : ""}</div>`;
    const canOpen = !!(c.items && c.items.length);
    const toggle = canOpen ? `<button class="expand" type="button" data-k="${k}">${open ? "hide" : "show"} ${c.items.length} result${c.items.length === 1 ? "" : "s"}</button>` : "";
    return head + toggle + (open && canOpen ? this.items(c.items) : "");
  }

  detailBlock(d, hasCalls = false) {
    if (typeof d === "string") return `<div class="args">${esc(d)}</div>`;
    if (Array.isArray(d.items)) return this.items(d.items);
    const dup = hasCalls ? ["tool", "summary", "args", "label", "query"] : [];
    const rows = Object.entries(d).filter(([k, v]) => !dup.includes(k) && (typeof v !== "object" || v == null));
    if (!rows.length) return "";
    return `<div class="args">${rows.map(([a, v]) => `<b>${esc(a)}</b>=${esc(v)}`).join("  ")}</div>`;
  }

  items(items) {
    const isFact = items.some((x) => x.key != null && x.value != null);
    if (isFact) {
      return `<div class="hitlist">${items.map((f) => `<div class="factrow">
        <span><code>${esc(f.key)}</code> <span class="fv">${esc(f.value)}</span></span>
        <span class="dim mono" style="font-size:11px">${esc(f.as_of || "undated")}</span>
        <span class="dim mono" style="font-size:11px">${esc(f.domain || domainOf(f.url))}</span>
      </div>`).join("")}</div>`;
    }
    const scored = items.some((x) => Number(x.score) > 0);
    const dated = items.some((x) => x.date || x.published_at);
    const max = Math.max(...items.map((x) => Number(x.score) || 0), 1e-9);
    const cls = "hit" + (scored ? "" : " noscore") + (dated ? "" : " nodate");
    return `<div class="hitlist">${items.map((x) => `<div class="${cls}">
      <span class="hn">${x.n != null ? "[" + x.n + "]" : ""}</span>
      <span class="ht" title="${esc(x.title || x.url)}">${esc(x.title || domainOf(x.url))} <span class="dim">· ${esc(x.domain || domainOf(x.url))}</span></span>
      ${dated ? `<span class="hd">${esc(x.date || x.published_at || "undated")}</span>` : ""}
      ${scored ? `<span class="hb" title="score ${esc(x.score ?? "")}"><i style="width:${Math.max(3, Math.round(100 * (Number(x.score) || 0) / max))}%"></i></span>` : ""}
    </div>`).join("")}</div>`;
  }
}
