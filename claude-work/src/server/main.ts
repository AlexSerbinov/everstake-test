// HTTP API + static UI. Everything the UI shows comes from these endpoints,
// so the same numbers are available to scripts, the MCP tool and the eval runner.

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

export const app = new Hono();
app.use("/api/*", cors());
app.use("/ask", cors());
app.use("/ask/stream", cors());

// --- rate limit: 30 requests / minute / IP on the expensive endpoint -------------------
const hits = new Map<string, number[]>();
const rateLimit: MiddlewareHandler = async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "local";
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 30) return c.json({ error: "rate limit: 30 questions per minute" }, 429);
  arr.push(now); hits.set(ip, arr);
  await next();
};
app.use("/ask", rateLimit);
app.use("/ask/stream", rateLimit);

/** `{question}` → the question, or an error response if it is missing/too long. */
async function readQuestion(c: Context): Promise<{ question: string; body: any } | Response> {
  const body = await c.req.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();
  if (!question) return c.json({ error: "question is required" }, 400);
  if (question.length > 500) return c.json({ error: "question too long (500 chars max)" }, 400);
  return { question, body };
}

// Same answer as /ask/stream, waited for instead of watched. `steps[]` carries the tool trace.
app.post("/ask", async (c) => {
  const q = await readQuestion(c);
  if (q instanceof Response) return q;
  const r = await answerQuestion(q.question);
  return c.json(q.body.trace === false ? { ...r, trace: undefined } : r);
});

// The agent's pipeline as it happens: stage / tool_call / tool_result / note / final / error.
// Events are pushed synchronously from the agent's emit callback into this stream.
app.post("/ask/stream", async (c) => {
  const q = await readQuestion(c);
  if (q instanceof Response) return q;
  return streamSSE(c, async (stream) => {
    // The agent emits synchronously; the queue keeps writes ordered without awaiting inside emit().
    let queue: Promise<void> = Promise.resolve();
    const send = (event: string, data: unknown) => { queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })); };
    try {
      await answerQuestion(q.question, (e) => send(e.event, e.data));
    } catch (e: any) {
      send("error", { message: String(e?.message ?? e).slice(0, 300) });
    }
    await queue;
  });
});

app.get("/api/stats", (c) => c.json({ ...stats(), provider: { llm: env.llmProvider, embeddings: env.embeddingsProvider }, models: { ...getConfig().models, resolved_answer: resolveModel(getConfig().models.answer), resolved_cheap: resolveModel(getConfig().models.cheap) } }));
app.get("/api/config", (c) => c.json(getConfig()));
app.put("/api/config", async (c) => c.json(setConfigOverrides(await c.req.json())));
app.delete("/api/config", (c) => c.json(resetConfigOverrides()));
app.get("/api/sources-config", (c) => c.json(sourcesConfig));
app.get("/api/facts", (c) => c.json(factLedger(c.req.query("key") || undefined)));
app.get("/api/instructions", (c) => c.json(instructionsFound()));
app.get("/api/dedup", (c) => c.json(dedupClusters()));
app.get("/api/cost", (c) => c.json(costReport(true)));
app.get("/api/eval", (c) => c.json(latestEval()));
app.get("/api/questions", (c) => c.json(all(`SELECT id, ts, question, status, mode, cost_usd, latency_ms FROM questions_log ORDER BY id DESC LIMIT 50`)));
app.get("/api/doc/:id", (c) => {
  const d = one<any>(`SELECT id, url, final_url, canonical_url, domain, category, tier, title, published_at, date_source, text_chars, ai_directed, instruction_hits, duplicate_of, text FROM documents WHERE id = ?`, Number(c.req.param("id")));
  if (!d) return c.json({ error: "not found" }, 404);
  d.aliases = all(`SELECT id, url, dedup_method, similarity FROM documents WHERE duplicate_of = ?`, d.id);
  d.instructions = all(`SELECT sentence FROM instructions WHERE doc_id = ?`, d.id).map((r: any) => r.sentence);
  d.facts = all(`SELECT key, value, as_of, quote FROM facts WHERE doc_id = ?`, d.id);
  return c.json(d);
});
app.get("/api/docs", (c) => {
  const q = c.req.query("q") ?? "";
  return c.json(all(`SELECT id, url, title, domain, tier, category, published_at, text_chars, ai_directed, duplicate_of, status, drop_reason FROM documents WHERE (url LIKE ? OR title LIKE ?) ORDER BY status, tier, published_at DESC LIMIT 300`, `%${q}%`, `%${q}%`));
});
app.get("/health", (c) => c.json({ ok: true }));

app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, "public")) || "public" }));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server/main.ts") || process.argv[1]?.endsWith("server/main.js")) {
  serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`everstake-kb listening on http://localhost:${info.port}  (llm=${env.llmProvider}, embeddings=${env.embeddingsProvider})`));
}
