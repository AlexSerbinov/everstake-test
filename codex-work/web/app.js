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
  select('#answer').textContent = data.answer;
  select('#reasoning').textContent = data.reasoning;
  select('#usage').textContent = JSON.stringify(data.usage, null, 2);
  renderSources(data.sources);
  renderAuditReceipt(data.audit);
  resetSubmitButton('Run evidence agent');
}

/** List each cited source with its provenance, date and content hash. */
function renderSources(sources) {
  const list = select('#sources');
  list.innerHTML = '';
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
    // First 10 hex characters of the SHA-256: enough for a human to compare against the
    // audit record at a glance, and the full hash is in the receipt for real checking.
    const provenance = source.provenance.replaceAll('_', ' ');
    meta.textContent = `${provenance} · ${source.date} · ${source.content_sha256.slice(0, 10)}`;
    item.append(link, meta);
    list.append(item);
  });
  select('#source-count').textContent = `${sources.length} source${sources.length === 1 ? '' : 's'}`;
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
