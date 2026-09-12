/**
 * Browser client for the evidence agent.
 *
 * Talks to exactly one endpoint: POST /api/query/stream, which answers with Server-Sent
 * Events rather than one JSON body. Six event types arrive, in this order:
 *
 *   thinking      - mode resolved, the run has started
 *   tool_call     - the model asked for a tool, with its arguments
 *   tool_result   - what that tool returned (refs and hashes only, never passage text)
 *   verification  - the deterministic gate's verdict: passed, abstained or blocked
 *   answer        - the final result plus its signed audit receipt; ends the run
 *   error         - the server failed mid-stream, after headers were already sent
 *
 * The first four are rendered as a running pipeline. That visible trace is the product,
 * not decoration: it is what shows the answer came from named tools over dated sources
 * rather than from model memory.
 *
 * Loaded as an external file because the server's CSP sets script-src 'self' with no
 * unsafe-inline, so inline handlers and inline <script> would simply not execute.
 */

const select = selector => document.querySelector(selector);

const form = select('#query-form');
const questionInput = select('#question');
const resultPanel = select('#result');
const pipelinePanel = select('#pipeline');
let costLoaded = false;
let freshnessLoaded = false;
let freshnessData = null;

// Sequence number shown in each pipeline row's badge. Reset at the start of every run.
let completedSteps = 0;

// Theme is applied before anything renders so a returning visitor never sees a flash of
// the wrong palette. Dark is the default when nothing was stored.
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';

select('#theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
};

document.querySelectorAll('[data-view]').forEach(button => {
  button.onclick = () => showView(button.dataset.view);
});

function showView(name) {
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `${name}-view`; });
  document.querySelectorAll('[data-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.view === name);
  });
  history.replaceState(null, '', `#${name}`);
  if (name === 'cost' && !costLoaded) loadCostView();
  if (name === 'freshness' && !freshnessLoaded) loadFreshnessView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

showView(['cost', 'freshness'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'ask');

async function loadFreshnessView() {
  try {
    const response = await fetch('/api/freshness');
    if (!response.ok) throw new Error(`Freshness report failed (${response.status})`);
    freshnessData = await response.json();
    renderFreshnessStatus(freshnessData.status);
    applyFreshnessPolicy(freshnessData.calculator.selected.sources,
      freshnessData.calculator.selected.preset);
    const units = freshnessData.calculator.units;
    select('#fresh-assumptions').textContent = `Measured on ${units.machine}; prices copied ${units.price_date}. Fetch, extraction and embedding units come from the ledger. Per-row change rates are explicit planning inputs, not prices.`;
    freshnessLoaded = true;
  } catch (error) {
    select('#last-refreshed').textContent = 'Freshness data unavailable';
  }
}

function renderFreshnessStatus(status) {
  select('#last-refreshed').textContent = status.last_refreshed
    ? new Date(status.last_refreshed).toLocaleString() : 'No completed run yet';
  select('#change-summary').textContent = status.recent_changes.length
    ? `${status.recent_changes.length} recent changes` : 'No content changes detected';
  const log = select('#change-log');
  log.innerHTML = '';
  if (!status.runs.length) {
    const empty = document.createElement('p');
    empty.textContent = 'The first scheduled run will appear here.';
    log.append(empty);
    return;
  }
  status.runs.forEach(run => {
    const row = document.createElement('div');
    const heading = document.createElement('strong');
    const detail = document.createElement('span');
    heading.textContent = `${new Date(run.finished_at).toLocaleString()} · ${run.changed} changed`;
    detail.textContent = run.changes.length
      ? run.changes.slice(0, 3).map(change => change.title || change.url).join(' · ')
      : `${run.checked} pages checked; no content hash changed`;
    row.append(heading, detail);
    log.append(row);
  });
}

document.querySelectorAll('[data-preset]').forEach(button => {
  button.onclick = () => {
    if (!freshnessData || button.dataset.preset === 'custom') return;
    applyFreshnessPolicy(freshnessData.calculator.presets[button.dataset.preset], button.dataset.preset);
  };
});

function applyFreshnessPolicy(policy, preset = 'custom') {
  document.querySelectorAll('[data-preset]').forEach(button => {
    button.classList.toggle('active', button.dataset.preset === preset);
  });
  const rows = select('#fresh-rows');
  rows.innerHTML = '';
  Object.entries(policy).forEach(([name, choice]) => {
    const row = document.createElement('div');
    row.className = 'fresh-row';
    const copy = document.createElement('div');
    copy.innerHTML = `<strong>${freshnessData.calculator.source_labels[name]}</strong><small>${freshnessData.calculator.profile.counts[name]} sources · ${(freshnessData.calculator.change_rates[name] * 100).toFixed(0)}% change/run</small>`;
    row.append(copy,
      makeFreshSelect('interval', name, freshnessData.calculator.options.intervals, choice.interval),
      makeFreshSelect('depth', name, freshnessData.calculator.options.depths, choice.depth));
    rows.append(row);
  });
  updateFreshnessCalculation();
}

function makeFreshSelect(kind, name, options, selected) {
  const control = document.createElement('select');
  control.dataset.freshKind = kind;
  control.dataset.source = name;
  Object.entries(options).forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    control.append(option);
  });
  control.onchange = () => {
    document.querySelectorAll('[data-preset]').forEach(button => {
      button.classList.toggle('active', button.dataset.preset === 'custom');
    });
    updateFreshnessCalculation();
  };
  return control;
}

function currentFreshnessPolicy() {
  const sources = {};
  document.querySelectorAll('[data-fresh-kind="interval"]').forEach(control => {
    sources[control.dataset.source] = { interval: control.value };
  });
  document.querySelectorAll('[data-fresh-kind="depth"]').forEach(control => {
    sources[control.dataset.source].depth = control.value;
  });
  return sources;
}

function calculateFreshness(policy, data) {
  const intervalHours = { hourly: 1, six_hours: 6, daily: 24, weekly: 168, monthly: 720, never: null };
  const totals = { cost: 0, tokens: 0, minutes: 0, worst: 0, never: false, rows: [] };
  Object.entries(policy).forEach(([name, choice]) => {
    const interval = intervalHours[choice.interval];
    const count = data.profile.counts[name];
    const runs = interval === null ? 0 : 720 / interval;
    const rate = data.change_rates[name];
    const changed = runs * count * rate;
    const rebuilds = interval === null || !count ? 0 : runs * (1 - Math.pow(1 - rate, count));
    let chunks = 0;
    if (choice.depth === 'reextract') chunks = changed * data.profile.chunks_per_doc;
    if (choice.depth === 'full') chunks = rebuilds * data.profile.total_chunks;
    const extract = choice.depth === 'cheap' ? 0 : changed;
    const cost = extract * data.units.extract_cost_usd + chunks * data.units.embedding_cost_usd;
    const tokens = extract * data.units.extract_tokens + chunks * data.units.embedding_tokens;
    const milliseconds = runs * (data.units.run_overhead_ms + count * data.units.fetch_wall_ms)
      + extract * data.units.extract_wall_ms + chunks * data.units.embedding_wall_ms;
    totals.cost += cost;
    totals.tokens += tokens;
    totals.minutes += milliseconds / 60000;
    totals.never ||= interval === null;
    if (interval !== null) totals.worst = Math.max(totals.worst, interval);
    totals.rows.push({ name, cost, interval });
  });
  return totals;
}

function updateFreshnessCalculation() {
  const result = calculateFreshness(currentFreshnessPolicy(), freshnessData.calculator);
  select('#fresh-cost').textContent = money(result.cost);
  select('#fresh-tokens').textContent = numberFormat(Math.round(result.tokens));
  select('#fresh-time').textContent = `${result.minutes.toFixed(1)} min`;
  select('#fresh-stale').textContent = result.never ? 'Never checked' : staleness(result.worst);
  const chart = select('#fresh-chart');
  chart.innerHTML = '';
  const maximum = Math.max(...result.rows.map(row => row.cost), 0.000001);
  result.rows.forEach((row, index) => {
    const item = document.createElement('div');
    const share = Math.max(1, Math.round(row.cost / maximum * 20));
    item.innerHTML = `<span>${freshnessData.calculator.source_labels[row.name]}</span><i><b class="tone-${index % 7} share-${share}"></b></i><strong>${money(row.cost)}</strong>`;
    chart.append(item);
  });
  const blog = result.rows.find(row => row.name === 'blog');
  select('#fresh-sentence').textContent = `Checking the blog ${intervalSentence(blog.interval)} costs about ${money(blog.cost)}/month and finds a new post within ${staleness(blog.interval)}. The full policy uses measured units and explicit change-rate assumptions.`;
}

function intervalSentence(hours) {
  if (hours === null) return 'never';
  if (hours === 1) return 'hourly';
  if (hours === 24) return 'daily';
  if (hours === 168) return 'weekly';
  if (hours === 720) return 'monthly';
  return `every ${hours} hours`;
}

function staleness(hours) {
  if (hours === null) return 'never';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours < 168) return `${hours / 24} day${hours === 24 ? '' : 's'}`;
  if (hours < 720) return `${hours / 168} week${hours === 168 ? '' : 's'}`;
  return '1 month';
}

// Example-question chips. requestSubmit() rather than submit() so the form's own
// onsubmit handler still runs — submit() would bypass it and reload the page.
document.querySelectorAll('[data-q]').forEach(button => {
  button.onclick = () => {
    questionInput.value = button.dataset.q;
    form.requestSubmit();
  };
});

/** Append one step to the visible pipeline and mark the previous one finished. */
function addStep(title, detail = '') {
  completedSteps += 1;
  markActiveStepsDone();
  const row = document.createElement('div');
  row.className = 'pipeline-item active';
  const icon = document.createElement('span');
  icon.className = 'step-icon';
  icon.textContent = completedSteps;
  const copy = document.createElement('div');
  const heading = document.createElement('strong');
  const body = document.createElement('small');
  heading.textContent = title;
  // textContent, never innerHTML: `detail` carries tool arguments and server messages,
  // which originate in the question and in crawled pages. Assigning that as HTML would
  // hand a prompt-injected page a stored-XSS foothold in the operator's own UI.
  body.textContent = detail;
  copy.append(heading, body);
  row.append(icon, copy);
  pipelinePanel.append(row);
  // 'nearest' rather than 'center' so a long pipeline scrolls just enough to reveal the
  // new row, instead of yanking the answer card off screen.
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Move any step still marked active into the done state. */
function markActiveStepsDone() {
  document.querySelectorAll('.pipeline-item.active').forEach(node => {
    node.classList.remove('active');
    node.classList.add('done');
  });
}

/*
 * Markdown rendering for the answer body.
 * ---------------------------------------
 * The model writes Markdown ("**Non-custodial staking:** ...", numbered lists, the odd
 * table). Rendering it as plain text put literal asterisks in front of the reviewer, so
 * the answer is converted to HTML here.
 *
 * The answer text is UNTRUSTED. It is written by a language model over crawled third-party
 * pages, which is exactly the path a prompt-injection payload takes. So the order is fixed
 * and must not be rearranged: escape the whole string FIRST, then add markup. After
 * escapeHtml() there is no way for the input to introduce a tag, and every tag below is
 * one this function wrote itself.
 *
 * The subset is deliberately small — what the model actually emits, nothing more:
 *   **bold**, *italic*, `code`, # headings, - bullets, 1. numbers, ``` fences, | tables |
 *
 * Deliberately NOT supported, with reasons:
 *   [text](url)  — a URL from model output could be `javascript:`, and it would collide
 *                  with the "[3]" citation markers. Sources are rendered separately, from
 *                  server-supplied fields, where they can be trusted.
 *   _italic_     — snake_case identifiers (corpus_search, as_of) appear in answers and
 *                  would turn half a sentence italic.
 *   raw HTML     — escaped, always.
 */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, character => HTML_ESCAPES[character]);

// One pass over the already-escaped text. Backticks come first in the alternation so that
// `**not bold**` inside a code span stays literal.
const INLINE_MARKUP = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;

function renderInline(escapedText) {
  return escapedText.replace(INLINE_MARKUP, (match, code, bold, italic) => {
    if (code !== undefined) return `<code>${code}</code>`;
    if (bold !== undefined) return `<strong>${bold}</strong>`;
    return `<em>${italic}</em>`;
  });
}

const ORDERED_ITEM = /^\s*(\d+)[.)]\s+(.*)$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Split "| a | b |" into its cells, tolerating the optional outer pipes. */
const tableCells = line =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());

/** A pipe table needs a header row and the |---|---| divider directly under it. */
const isTable = lines => lines.length >= 2 && lines[0].includes('|') && TABLE_DIVIDER.test(lines[1]);

function renderTable(lines) {
  const header = tableCells(lines[0]).map(cell => `<th>${renderInline(cell)}</th>`).join('');
  const body = lines.slice(2)
    .map(line => `<tr>${tableCells(line).map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Headings are capped at h3/h4: the answer lives inside a card, so a real h1 would
 *  outrank the page's own title. */
function renderHeading(line) {
  const [, hashes, content] = line.match(HEADING);
  const level = hashes.length <= 2 ? 3 : 4;
  return `<h${level}>${renderInline(content)}</h${level}>`;
}

function renderList(lines, ordered) {
  const items = lines
    .map(line => (ordered ? line.match(ORDERED_ITEM)[2] : line.match(BULLET_ITEM)[1]))
    .map(item => `<li>${renderInline(item)}</li>`)
    .join('');
  // `start` keeps a list that opens at "3." numbered from 3 rather than silently from 1.
  const start = ordered ? Number(lines[0].match(ORDERED_ITEM)[1]) : 1;
  if (!ordered) return `<ul>${items}</ul>`;
  return `<ol${start !== 1 ? ` start="${start}"` : ''}>${items}</ol>`;
}

const lineKind = line => {
  if (ORDERED_ITEM.test(line)) return 'ordered';
  if (BULLET_ITEM.test(line)) return 'bullet';
  if (HEADING.test(line)) return 'heading';
  return 'text';
};

/*
 * One block = the lines between two blank lines. It is NOT always one thing: the model
 * habitually writes a lead-in and its list with no blank line between them —
 *
 *   Main areas of the business:
 *   1. **Non-custodial staking:** ...
 *
 * — so the block is split into runs of same-kind lines and each run rendered on its own.
 * Requiring the whole block to be a list is what left "1." sitting in a paragraph.
 */
function renderBlock(lines) {
  if (isTable(lines)) return renderTable(lines);
  const html = [];
  let run = [];
  let kind = null;
  const flushRun = () => {
    if (!run.length) return;
    if (kind === 'ordered') html.push(renderList(run, true));
    else if (kind === 'bullet') html.push(renderList(run, false));
    else if (kind === 'heading') html.push(run.map(renderHeading).join(''));
    // A single newline inside a paragraph is a line break, the way the model means it.
    else html.push(`<p>${run.map(renderInline).join('<br>')}</p>`);
    run = [];
  };
  for (const line of lines) {
    const kindOfLine = lineKind(line);
    if (kindOfLine !== kind) {
      flushRun();
      kind = kindOfLine;
    }
    run.push(line);
  }
  flushRun();
  return html.join('');
}

/**
 * Markdown → HTML for one answer. Returns a string for innerHTML; safe because the input
 * was escaped before any tag was added.
 */
function renderMarkdown(rawText) {
  const escaped = escapeHtml(rawText).replace(/\r\n?/g, '\n');
  const html = [];
  // Fenced code blocks are pulled out first, whole, so their contents are never parsed
  // as lists or headings.
  for (const [index, section] of escaped.split(/^```.*$/m).entries()) {
    if (index % 2 === 1) {
      html.push(`<pre><code>${section.replace(/^\n|\n$/g, '')}</code></pre>`);
      continue;
    }
    for (const paragraph of section.split(/\n{2,}/)) {
      const lines = paragraph.split('\n').filter(line => line.trim());
      if (lines.length) html.push(renderBlock(lines));
    }
  }
  return html.join('');
}

/** Render the final answer, its sources and its audit receipt. */
function renderAnswer(data) {
  markActiveStepsDone();
  select('#answer-card').hidden = false;
  // `sufficient` is the server's deterministic verdict, not the model's confidence. The
  // badge must track it exactly: an abstention shown as a verified answer is the single
  // worst failure this UI can have.
  select('#status').className = data.sufficient ? 'supported' : 'abstained';
  select('#status').innerHTML = `<i></i> ${data.sufficient ? 'Verified answer' : 'Evidence insufficient'}`;
  select('#date').textContent = data.as_of ? `Evidence as of ${data.as_of}` : '';
  // innerHTML, not textContent: the model writes Markdown and renderMarkdown escapes
  // the text before it adds a single tag. See the block comment above.
  select('#answer').innerHTML = renderMarkdown(data.answer);
  select('#reasoning').textContent = data.reasoning;
  renderCostReceipt(data.cost_receipt);
  renderSources(data.sources);
  renderAuditReceipt(data.audit);
  resetSubmitButton('Run evidence agent');
}

/** Render a plain-language, expandable receipt whose total comes from server accounting. */
function renderCostReceipt(receipt) {
  const steps = select('#receipt-steps');
  steps.innerHTML = '';
  if (!receipt) {
    select('#cost-receipt').hidden = true;
    return;
  }
  select('#cost-receipt').hidden = false;
  select('#receipt-summary').textContent = `${money(receipt.cost_usd)} · ${duration(receipt.wall_ms)}`;
  receipt.steps.forEach((step, index) => {
    const row = document.createElement('div');
    row.className = 'receipt-step';
    const number = document.createElement('span');
    number.className = 'receipt-number';
    number.textContent = index + 1;
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = step.name;
    const detail = document.createElement('small');
    detail.textContent = step.model
      ? `${step.model} · ${numberFormat(step.tokens.input)} in (${numberFormat(step.tokens.cached_input)} cached) · ${numberFormat(step.tokens.output)} out`
      : 'Code · free';
    copy.append(title, detail);
    const amount = document.createElement('div');
    amount.className = 'receipt-amount';
    amount.innerHTML = `<strong>${money(step.cost_usd)}</strong><small>${duration(step.wall_ms)}</small>`;
    row.append(number, copy, amount);
    steps.append(row);
  });
  select('#receipt-total').textContent = `Total · ${numberFormat(receipt.tokens.input)} tokens in · ${numberFormat(receipt.tokens.output)} out · ${money(receipt.cost_usd)} · ${duration(receipt.wall_ms)}`;
}

async function loadCostView() {
  try {
    const response = await fetch('/api/costs');
    if (!response.ok) throw new Error(`Cost report failed (${response.status})`);
    renderCostView(await response.json());
    costLoaded = true;
  } catch (error) {
    select('#cost-headline').textContent = 'Measured cost data is temporarily unavailable.';
  }
}

function renderCostView(report) {
  const headline = report.headline;
  select('#cost-headline').textContent = `Building the whole index cost ${money(headline.index_cost_usd)}. One measured question averages ${money(headline.mean_question_cost_usd)}.`;
  select('#index-cost').textContent = money(headline.index_cost_usd);
  select('#index-time').textContent = `${duration(headline.index_wall_ms)} measured wall time`;
  select('#question-cost').textContent = money(headline.mean_question_cost_usd);
  select('#question-count').textContent = `mean of ${headline.measured_questions} full-agent questions`;
  renderStackedBar('money', report.stages, stage => stage.cost_usd);
  renderStackedBar('time', report.stages, stage => stage.wall_ms || 0);
  renderStages(report.stages);
  select('#cost-method').textContent = `Provider usage fields supply tokens; the process clock supplies wall/CPU time and peak RSS. Prices copied ${report.price_table_copied_at}.`;
}

function renderStackedBar(prefix, stages, valueOf) {
  const bar = select(`#${prefix}-bar`);
  const legend = select(`#${prefix}-legend`);
  bar.innerHTML = '';
  legend.innerHTML = '';
  const values = stages.map(valueOf);
  const total = values.reduce((sum, value) => sum + value, 0);
  stages.forEach((stage, index) => {
    const share = total ? values[index] / total : 0;
    if (share > 0) {
      const segment = document.createElement('span');
      segment.className = `tone-${index % 7} share-${Math.max(1, Math.round(share * 20))}`;
      segment.title = `${stage.label}: ${(share * 100).toFixed(1)}%`;
      bar.append(segment);
    }
    const item = document.createElement('span');
    item.innerHTML = `<i class="tone-${index % 7}"></i>${stage.label} <b>${(share * 100).toFixed(0)}%</b>`;
    legend.append(item);
  });
}

function renderStages(stages) {
  const list = select('#stage-list');
  list.innerHTML = '';
  stages.forEach(stage => {
    const details = document.createElement('details');
    details.className = 'stage-row';
    const summary = document.createElement('summary');
    const usage = stage.models.length
      ? `${numberFormat(stage.tokens.input)} in · ${numberFormat(stage.tokens.output)} out`
      : `${numberFormat(stage.units.count)} ${stage.units.label}`;
    summary.innerHTML = `<span><strong>${stage.label}</strong><small>${stage.code_or_model}${stage.models.length ? ` · ${stage.models.join(', ')}` : ''}</small></span><span>${usage}</span><span>${money(stage.cost_usd)}</span><span>${duration(stage.wall_ms)}</span>`;
    const runs = document.createElement('div');
    runs.className = 'stage-runs';
    stage.runs.slice().reverse().forEach(run => {
      const row = document.createElement('div');
      row.textContent = `${new Date(run.started_at).toLocaleString()} · ${run.machine} · CPU ${duration(run.cpu_ms)} · peak ${run.peak_rss_mb} MB · ${money(run.cost_usd)}`;
      runs.append(row);
    });
    details.append(summary, runs);
    list.append(details);
  });
}

function money(value) {
  return `$${Number(value || 0).toFixed(Number(value) < 0.01 ? 6 : 2)}`;
}

function duration(milliseconds) {
  const value = Number(milliseconds || 0);
  if (value >= 60000) return `${(value / 60000).toFixed(1)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(0)} ms`;
}

function numberFormat(value) {
  return Number(value || 0).toLocaleString('en-US');
}

/**
 * List each cited page with its provenance, date and the hash of every cited passage.
 * The server already folds chunk-level citations under their page (`_source_records`
 * in app/agent.py), so one page cited three times is one row saying "3 passages", not
 * three identical rows pretending to be three sources.
 */
function renderSources(sources) {
  const list = select('#sources');
  list.innerHTML = '';
  let passageCount = 0;
  sources.forEach(source => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const meta = document.createElement('span');
    link.href = source.url;
    link.target = '_blank';
    // noopener stops the opened page reaching back through window.opener; these are
    // third-party-editable URLs from the corpus.
    link.rel = 'noopener';
    link.textContent = source.title;
    // Older receipts (before passages were grouped) carry one hash at the top level.
    const passages = source.passages || [{ ref: source.ref, content_sha256: source.content_sha256 }];
    passageCount += passages.length;
    // First 10 hex characters of each SHA-256: enough for a human to compare against the
    // audit record at a glance, and the full hashes are in the receipt for real checking.
    const hashes = passages.map(passage => `${passage.ref} ${passage.content_sha256.slice(0, 10)}`).join(' · ');
    const provenance = source.provenance.replaceAll('_', ' ');
    const count = passages.length > 1 ? ` · ${passages.length} passages` : '';
    meta.textContent = `${provenance} · ${source.date}${count} · ${hashes}`;
    item.append(link, meta);
    list.append(item);
  });
  const pages = `${sources.length} source${sources.length === 1 ? '' : 's'}`;
  select('#source-count').textContent = passageCount > sources.length
    ? `${pages} · ${passageCount} passages`
    : pages;
}

/** Link the answer to its signed audit record, when one was issued. */
function renderAuditReceipt(audit) {
  if (!audit) return;
  select('#audit').hidden = false;
  select('#audit').href = audit.verify_url;
  select('#audit-hash').textContent = `${audit.record_hash.slice(0, 20)}…`;
}

/** Re-enable the submit button with the given label. */
function resetSubmitButton(label) {
  select('#submit').disabled = false;
  select('#submit span').textContent = label;
}

/** Route one SSE event to the pipeline or to the answer card. */
function handleEvent(type, data) {
  if (type === 'thinking') addStep('Planning', data.message);
  if (type === 'tool_call') addStep(`Calling ${data.tool}`, formatToolArguments(data.arguments));
  if (type === 'tool_result') addStep(`${data.tool} returned`, describeToolResult(data));
  if (type === 'verification') addStep('Verification', data.message);
  if (type === 'answer') renderAnswer(data);
  // Thrown rather than rendered here so the one catch block in the submit handler owns
  // every failure path, whether it came from the network or from the server.
  if (type === 'error') throw new Error(data.error || 'Request failed');
}

/** Flatten a tool's arguments into one readable line. */
function formatToolArguments(argumentsObject) {
  return Object.entries(argumentsObject || {})
    // Nested objects (everstake_mcp's `arguments`) are stringified so the MCP sub-tool
    // and its parameters stay visible instead of rendering as [object Object].
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' · ');
}

/** Say what a tool returned: its error, or how many evidence items it captured. */
function describeToolResult(data) {
  const count = (data.evidence || []).length;
  return data.error || `${count} evidence item${count === 1 ? '' : 's'} captured and hashed`;
}

form.onsubmit = async event => {
  event.preventDefault();
  startRun();
  try {
    const response = await fetch('/api/query/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({ question: questionInput.value, mode: select('#mode').value }),
    });
    // A 400 or 404 arrives with a normal body, never as a stream, so it has to be caught
    // before the reader below waits for events that will never come.
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    await consumeEventStream(response);
  } catch (error) {
    showRunFailure(error);
  }
};

/** Clear the previous run's output and put the UI into its working state. */
function startRun() {
  completedSteps = 0;
  resultPanel.hidden = false;
  pipelinePanel.innerHTML = '';
  select('#answer-card').hidden = true;
  select('#audit').hidden = true;
  select('#cost-receipt').hidden = true;
  select('#status').className = 'working';
  select('#status').innerHTML = '<i></i> Agent running';
  select('#date').textContent = '';
  // Disabled for the whole run: a second submit would open a parallel stream writing
  // into the same pipeline element, interleaving two runs' steps.
  select('#submit').disabled = true;
  select('#submit span').textContent = 'Working…';
  resultPanel.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * Read the SSE body and dispatch each complete event.
 *
 * Hand-parsed rather than using EventSource, because EventSource can only issue GET
 * requests and the question is sent in a POST body. A manual buffer is therefore needed:
 * a network chunk can split an event in half or carry three at once, so events are only
 * dispatched once the blank-line terminator (\n\n) that ends one has actually arrived.
 */
async function consumeEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // stream: true keeps a multi-byte UTF-8 character that straddles two chunks intact.
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchEventBlock(block);
    }
  }
}

/** Parse one `event:`/`data:` block and hand it to the event router. */
function dispatchEventBlock(block) {
  // The m flag matters: the two fields are separate lines within the block.
  const type = (block.match(/^event: (.+)$/m) || [])[1];
  const raw = (block.match(/^data: (.+)$/m) || [])[1];
  if (type && raw) handleEvent(type, JSON.parse(raw));
}

/** Show a failed run in place, leaving the pipeline visible for diagnosis. */
function showRunFailure(error) {
  addStep('Request failed', error.message);
  select('#status').className = 'error';
  select('#status').innerHTML = '<i></i> Error';
  select('#answer-card').hidden = false;
  // A generic sentence, not error.message: the message can carry an internal exception
  // class name, and the pipeline step above already shows it for anyone debugging.
  select('#answer').textContent = 'The agent could not complete this request. Please try again.';
  resetSubmitButton('Try again');
}
