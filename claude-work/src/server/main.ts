// HTTP API + the static UI, and the SSE stream the UI's pipeline panel is driven by.
//
// The design rule for this file: the UI must have no numbers of its own. Everything shown in
// the browser — corpus size, dedup clusters, stripped instructions, measured cost, the latest
// eval — is fetched from one of the endpoints below, so a reviewer can curl the same URL the
// page uses and get the same figure. If the UI could compute or hardcode a number, the demo
// and the report could quietly disagree; this way they cannot.
//
// Routes (all JSON unless noted):
//   POST /ask           — ask, wait, get the whole AskResult including the tool trace
//   POST /ask/stream    — ask and watch: text/event-stream, contract in docs/agentic-spec.md
//   GET  /api/stats     — corpus + provider + resolved model names
//   GET/PUT/DELETE /api/config — the tunable gates and models, so the demo can toggle a defence
//   GET  /api/sources-config, /api/facts, /api/instructions, /api/dedup
//   GET  /api/cost, /api/eval, /api/questions, /api/docs, /api/doc/:id
//   GET  /api/freshness             — policy, presets priced, measured units, per-type status
//   GET/POST /api/freshness/estimate— price a named preset / an arbitrary policy
//   GET  /api/freshness/log         — the change log: what the last runs found
//   GET  /health        — {ok:true}, used by the deployment check
//   GET  /*             — the static UI from public/
//
// If the SSE event names or payload keys here drift from docs/agentic-spec.md, the pipeline
// panel in public/pipeline.js silently renders nothing — there is no error, just an empty list.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import path from "node:path";
import { ROOT, env, getConfig, resetConfigOverrides, setConfigOverrides, sourcesConfig } from "../config.js";
import { all, one } from "../db.js";
import { resolveModel } from "../llm.js";
import { factLedger } from "../index/facts.js";
import { ask } from "../ask/ask.js";
import { answerQuestion } from "../ask/agent.js";
import { dedupClusters, instructionsFound, stats } from "../ask/stats.js";
import { costReport } from "../eval/cost.js";
import { latestEval } from "../eval/run.js";
import { estimateFreshness } from "../refresh/calculator.js";
import { normalisePolicy } from "../refresh/policy.js";
import { freshnessStatus, refreshLog } from "../refresh/refresh.js";
import { corpusProfile, measureUnits } from "../refresh/units.js";
import { startScheduler } from "../refresh/schedule.js";

/** Questions per IP per window. Chosen to be generous for a demo and useless for a bill attack. */
const MAX_QUESTIONS_PER_WINDOW = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Longer than any real question, and short enough that a pasted document cannot be smuggled in. */
const MAX_QUESTION_CHARS = 500;

/** Provider errors can carry a whole stack; the client only needs enough to report it. */
const MAX_ERROR_CHARS = 300;

const RECENT_QUESTIONS_LIMIT = 50;
const DOC_SEARCH_LIMIT = 300;

export const app = new Hono();
app.use("/api/*", cors());
app.use("/ask", cors());
app.use("/ask/stream", cors());

// --- rate limit ------------------------------------------------------------------------
// /ask is the only endpoint that spends money: every call is several paid model calls. This
// is a sliding window per client IP, held in memory — deliberately not Redis, because the
// deployment is a single process and an extra dependency would be the more fragile choice.
// Consequence to know: it resets on restart, and it is per-process, so it protects the bill
// rather than enforcing a quota.
const requestTimestampsByIp = new Map<string, number[]>();

const rateLimit: MiddlewareHandler = async (c, next) => {
  // Behind the reverse proxy the real client is the first x-forwarded-for hop; "local" is the
  // fallback for a direct connection, which lumps all direct callers into one bucket.
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "local";
  const now = Date.now();
  const recent = (requestTimestampsByIp.get(ip) ?? []).filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= MAX_QUESTIONS_PER_WINDOW) {
    return c.json({ error: `rate limit: ${MAX_QUESTIONS_PER_WINDOW} questions per minute` }, 429);
  }
  recent.push(now);
  requestTimestampsByIp.set(ip, recent);
  await next();
};
app.use("/ask", rateLimit);
app.use("/ask/stream", rateLimit);

// --- asking ------------------------------------------------------------------------------

/**
 * Validates the `{question}` body shared by both ask endpoints. Returns either the question
 * or an already-built 400 Response, so the caller's first line stays a single guard.
 */
async function readQuestion(c: Context): Promise<{ question: string; body: any } | Response> {
  // A malformed body is treated as an empty one so the client gets "question is required"
  // rather than a 500 from the JSON parser.
  const body = await c.req.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();
  if (!question) return c.json({ error: "question is required" }, 400);
  if (question.length > MAX_QUESTION_CHARS) {
    return c.json({ error: `question too long (${MAX_QUESTION_CHARS} chars max)` }, 400);
  }
  return { question, body };
}

// Same answer as /ask/stream, waited for instead of watched. `steps[]` carries the tool trace.
// `{"trace": false}` drops the trace for callers that only want the answer.
app.post("/ask", async (c) => {
  const parsed = await readQuestion(c);
  if (parsed instanceof Response) return parsed;
  const result = await answerQuestion(parsed.question);
  return c.json(parsed.body.trace === false ? { ...result, trace: undefined } : result);
});

// The agent's pipeline as it happens. Event names — `stage`, `tool_call`, `tool_result`,
// `note`, `final`, `error` — and their payload keys are the contract in docs/agentic-spec.md;
// public/pipeline.js switches on exactly these strings.
app.post("/ask/stream", async (c) => {
  const parsed = await readQuestion(c);
  if (parsed instanceof Response) return parsed;
  return streamSSE(c, async (stream) => {
    // The agent's emit() is synchronous and must not be made to await, or the tool loop would
    // block on the socket. So each write is chained onto a promise queue: writes stay in the
    // order they were emitted, and emit() returns immediately.
    let queue: Promise<void> = Promise.resolve();
    const send = (event: string, data: unknown) => {
      queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
    };
    try {
      await answerQuestion(parsed.question, (e) => send(e.event, e.data));
    } catch (e: any) {
      // The stream is already open, so an error is delivered as a final `error` event rather
      // than an HTTP status the client can no longer see.
      send("error", { message: String(e?.message ?? e).slice(0, MAX_ERROR_CHARS) });
    }
    await queue;   // do not close the stream until every queued write has flushed
  });
});

// --- read-only views of the index ----------------------------------------------------------

// `resolved_*` is what the provider will actually serve for the configured name — the UI shows
// it because config saying "claude-opus-5" while Gemini answers would otherwise be invisible.
app.get("/api/stats", (c) => {
  const models = getConfig().models;
  return c.json({
    ...stats(),
    provider: { llm: env.llmProvider, embeddings: env.embeddingsProvider },
    models: {
      ...models,
      resolved_answer: resolveModel(models.answer),
      resolved_cheap: resolveModel(models.cheap),
    },
  });
});

// The config endpoints exist so the demo can switch a defence off and re-ask the same question
// live. Overrides are process-local and DELETE restores the file values.
app.get("/api/config", (c) => c.json(getConfig()));
app.put("/api/config", async (c) => c.json(setConfigOverrides(await c.req.json())));
app.delete("/api/config", (c) => c.json(resetConfigOverrides()));

app.get("/api/sources-config", (c) => c.json(sourcesConfig));
app.get("/api/facts", (c) => c.json(factLedger(c.req.query("key") || undefined)));
app.get("/api/instructions", (c) => c.json(instructionsFound()));
app.get("/api/dedup", (c) => c.json(dedupClusters()));

// The same objects EVAL.md and `npm run cost` are rendered from, so the page cannot show a
// number the report does not.
app.get("/api/cost", (c) => c.json(costReport(true)));
app.get("/api/eval", (c) => c.json(latestEval()));

app.get("/api/questions", (c) => c.json(all(
  `SELECT id, ts, question, status, mode, cost_usd, latency_ms FROM questions_log ORDER BY id DESC LIMIT ${RECENT_QUESTIONS_LIMIT}`)));

/** One document with everything that was derived from it — what a citation link opens. */
app.get("/api/doc/:id", (c) => {
  const doc = one<any>(
    `SELECT id, url, final_url, canonical_url, domain, category, tier, title, published_at, date_source,
            text_chars, ai_directed, instruction_hits, duplicate_of, text
     FROM documents WHERE id = ?`, Number(c.req.param("id")));
  if (!doc) return c.json({ error: "not found" }, 404);
  doc.aliases = all(`SELECT id, url, dedup_method, similarity FROM documents WHERE duplicate_of = ?`, doc.id);
  doc.instructions = all(`SELECT sentence FROM instructions WHERE doc_id = ?`, doc.id)
    .map((row: any) => row.sentence);
  doc.facts = all(`SELECT key, value, as_of, quote FROM facts WHERE doc_id = ?`, doc.id);
  return c.json(doc);
});

/** Corpus browser. `q` is a substring of the URL or title; empty `q` lists everything. */
app.get("/api/docs", (c) => {
  const query = c.req.query("q") ?? "";
  const like = `%${query}%`;
  // Ordered so live documents come before dropped ones and tier 1 before tier 3 — the reader
  // should see the sources the answers actually rely on first.
  return c.json(all(
    `SELECT id, url, title, domain, tier, category, published_at, text_chars, ai_directed, duplicate_of, status, drop_reason
     FROM documents WHERE (url LIKE ? OR title LIKE ?)
     ORDER BY status, tier, published_at DESC LIMIT ${DOC_SEARCH_LIMIT}`, like, like));
});

// --- freshness -------------------------------------------------------------------------------
//
// Three read endpoints and one estimator. The estimator is a GET with `?preset=` for the three
// named policies (so the UI's preset cards are three plain URLs a reviewer can curl) and a POST
// for whatever the sliders currently say. Both call the same pure function the tests pin, over
// the same measured units `npm run cost` reads — the page cannot show a price the ledger does
// not support.

/** Everything the Freshness view needs on first paint, in one round trip. */
app.get("/api/freshness", (c) => {
  const cfg = getConfig().freshness;
  const units = measureUnits();
  const corpus = corpusProfile();
  const presets = Object.fromEntries(Object.entries(cfg.presets).map(([name, policy]) => [
    name,
    { policy, estimate: estimateFreshness({ policy: normalisePolicy(policy, policy as any), units: units.units, corpus }) },
  ]));
  return c.json({
    preset: cfg.preset,
    active: cfg.active,
    // The whole section verbatim, so the UI can PUT it back with only `preset` and `active`
    // changed. `setConfigOverrides` merges one level deep, so a patch that named `active` alone
    // would drop `presets`, `scheduler` and `assumptions` from the live config.
    raw_section: cfg,
    presets,
    scheduler: cfg.scheduler,
    assumptions: { ...cfg.assumptions, units: units.notes },
    units: units.units,
    corpus,
    status: freshnessStatus(),
    active_estimate: estimateFreshness({
      policy: normalisePolicy(cfg.active, cfg.active as any), units: units.units, corpus,
    }),
  });
});

/** Price a named preset. `?policy=<json>` is accepted too, for a one-off check from a shell. */
app.get("/api/freshness/estimate", (c) => {
  const cfg = getConfig().freshness;
  const presetName = c.req.query("policy") ?? c.req.query("preset") ?? cfg.preset;
  const source = cfg.presets[presetName] ?? cfg.active;
  const policy = normalisePolicy(source, cfg.active as any);
  return c.json({
    policy_name: cfg.presets[presetName] ? presetName : "active",
    policy,
    estimate: estimateFreshness({ policy, units: measureUnits().units, corpus: corpusProfile() }),
  });
});

/** Price an arbitrary policy — what every slider drag in the UI calls. Pure and free. */
app.post("/api/freshness/estimate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cfg = getConfig().freshness;
  // Normalised against the active policy rather than rejected: a partial body from a curl should
  // price the difference it names, not 400.
  const policy = normalisePolicy(body.policy ?? body, cfg.active as any);
  return c.json({
    policy_name: "custom",
    policy,
    estimate: estimateFreshness({ policy, units: measureUnits().units, corpus: corpusProfile() }),
  });
});

/** The change log: the last few runs with everything they found. */
app.get("/api/freshness/log", (c) => c.json({
  runs: refreshLog(Number(c.req.query("limit") ?? 5)),
  status: freshnessStatus(),
}));

app.get("/health", (c) => c.json({ ok: true }));

// Must be registered last: this matches every path, so any route declared after it is dead.
app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, "public")) || "public" }));

// Listen only when this file is the entry point — importing `app` (tests, tooling) must not
// bind a port. The two `endsWith` cases cover being started through tsx (main.ts) and from the
// compiled build (main.js), where argv[1] is not the same string as import.meta.url.
if (import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith("server/main.ts")
  || process.argv[1]?.endsWith("server/main.js")) {
  serve({ fetch: app.fetch, port: env.port }, (info) =>
    console.log(`everstake-kb listening on http://localhost:${info.port}  (llm=${env.llmProvider}, embeddings=${env.embeddingsProvider})`));
  // The in-process freshness scheduler. A no-op unless `freshness.scheduler.enabled` is true or
  // REFRESH_SCHEDULER=1 — importing this module (tests, tooling) must never start a crawl.
  startScheduler();
}
