import { browseCorpus } from "./services/corpus/browse-corpus.js";
import type { UpdateController } from "./services/updates/controller.js";
import { runtimeManifest } from "./runtime-manifest.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { Database } from "./storage/database.js";
import { getSetting } from "./storage/database.js";
import type { AnswerResult, Emit } from "./contracts.js";
import { buildReceipt } from "./services/measurements/index.js";
import { readQuestions } from "./services/evaluation/run-evaluation.js";
export interface ApiDependencies {
  db: Database;
  ask: (
    question: string,
    emit: Emit,
    mode?: "agent" | "baseline",
    signal?: AbortSignal,
  ) => Promise<AnswerResult>;
  costs: () => unknown;
  updates?: UpdateController;
  refresh: (sourceId?: string) => Promise<unknown>;
}
export function createApi({
  db,
  ask,
  costs,
  refresh,
  updates,
}: ApiDependencies) {
  const app = new Hono();
  app.use("/api/*", bodyLimit({ maxSize: 16 * 1024 }));
  let busy = false;
  const manifest = runtimeManifest();
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      application: "Everstate Knowledge Base",
      codeVersion: manifest.codeVersion,
      configHash: manifest.configHash,
      corpusVersion: getSetting(db, "corpus_version", "unbuilt"),
    }),
  );
  app.get("/api/receipts/:id", (c) => {
    try {
      return c.json(buildReceipt(db, c.req.param("id")));
    } catch {
      return c.json({ error: "Receipt not found" }, 404);
    }
  });
  app.get("/api/questions", (c) => c.json({ questions: readQuestions() }));
  app.get("/api/costs", (c) => c.json(costs()));
  app.get("/api/evaluations", (c) =>
    c.json({
      runs: db
        .prepare("SELECT result FROM evaluations ORDER BY created_at DESC")
        .all()
        .map((r) => JSON.parse(String(r.result))),
    }),
  );
  app.get("/api/evaluations/:id", (c) => {
    const row = db
      .prepare("SELECT result FROM evaluations WHERE id=?")
      .get(c.req.param("id"));
    return row
      ? c.json(JSON.parse(String(row.result)))
      : c.json({ error: "Run not found" }, 404);
  });
  app.get("/api/runs/:id", (c) => {
    if (
      !process.env.ADMIN_TOKEN ||
      c.req.header("Authorization") !== `Bearer ${process.env.ADMIN_TOKEN}`
    )
      return c.json({ error: "Operator authorization required" }, 401);
    const row = db
      .prepare("SELECT result FROM answers WHERE run_id=?")
      .get(c.req.param("id"));
    return row
      ? c.json(JSON.parse(String(row.result)))
      : c.json({ error: "Run not found" }, 404);
  });
  app.get("/api/updates", (c) =>
    updates
      ? c.json(updates.status())
      : c.json({ error: "Updates unavailable" }, 503),
  );
  // Updates are an intentionally public demo action. Reject browser cross-site writes.
  app.use("/api/updates/*", async (c, next) => {
    if (
      !c.req
        .header("Content-Type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return c.json({ error: "Updates require a JSON request" }, 415);
    const origin = c.req.header("Origin");
    if (c.req.header("Sec-Fetch-Site") === "cross-site")
      return c.json(
        { error: "Updates must be started from this application" },
        403,
      );
    if (origin) {
      try {
        if (new URL(origin).host !== new URL(c.req.url).host)
          return c.json(
            { error: "Updates must be started from this application" },
            403,
          );
      } catch {
        return c.json({ error: "Invalid request origin" }, 403);
      }
    }
    await next();
  });
  app.put("/api/updates/settings", async (c) => {
    if (!updates) return c.json({ error: "Updates unavailable" }, 503);
    try {
      return c.json(updates.configure(await c.req.json()));
    } catch {
      return c.json(
        {
          error:
            "Invalid settings. Use configured sources, intervals of 1–8760 hours and priorities of 0–100.",
        },
        400,
      );
    }
  });
  app.post("/api/updates/run", async (c) => {
    if (!updates) return c.json({ error: "Updates unavailable" }, 503);
    try {
      const request = z
        .object({
          sourceId: z.string().min(1).max(100).optional(),
          due: z.boolean().optional(),
        })
        .strict()
        .parse(await c.req.json());
      const batch = updates.startBatch(request);
      return c.json({ jobs: updates.status().batchJobs, batch }, 202);
    } catch {
      return c.json(
        { error: "Invalid update request or disabled source" },
        400,
      );
    }
  });
  app.get("/api/refresh-jobs", (c) =>
    c.json({
      jobs: db
        .prepare(
          "SELECT value FROM settings WHERE key LIKE 'refresh_job:%' ORDER BY key",
        )
        .all()
        .map((r) => {
          const { stagePath, ...job } = JSON.parse(String(r.value));
          return job;
        }),
    }),
  );
  app.get("/api/corpus", (c) =>
    c.json(
      browseCorpus(db, {
        page: c.req.query("page"),
        q: c.req.query("q"),
        kind: c.req.query("kind"),
        copies: c.req.query("copies"),
      }),
    ),
  );
  app.post("/api/ask", async (c) => {
    if (busy)
      return c.json(
        { error: "Another request is running. Please try again shortly." },
        429,
      );
    const body = await c.req.text();
    if (body.length > 8000)
      return c.json({ error: "Question is too long" }, 413);
    let question: string;
    try {
      question = z
        .object({ question: z.string().trim().min(2).max(2000) })
        .parse(JSON.parse(body)).question;
    } catch {
      return c.json(
        { error: "Provide a question between 2 and 2000 characters" },
        400,
      );
    }
    busy = true;
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache");
    // A closed browser connection (Stop button, navigation, network loss) cancels the run
    // so the single worker is released immediately instead of finishing unpaid-for research.
    const cancel = new AbortController();
    const clientLeft = () => {
      if (cancel.signal.aborted) return;
      console.info("Client connection closed; cancelling the running question");
      cancel.abort();
    };
    c.req.raw.signal.addEventListener("abort", clientLeft, { once: true });
    return streamSSE(c, async (stream) => {
      stream.onAbort(clientLeft);
      let sequence = 0;
      let pending = Promise.resolve();
      const emit: Emit = (event) => {
        pending = pending
          .then(() =>
            stream.writeSSE({
              id: String(++sequence),
              event: event.type,
              data: JSON.stringify(event),
            }),
          )
          .then(() => {})
          .catch(() => {});
      };
      try {
        await ask(question, emit, "agent", cancel.signal);
        await pending;
      } catch {
        await stream
          .writeSSE({
            event: "error",
            data: JSON.stringify({
              runId: "request-error",
              type: "error",
              label: "Request failed",
              at: new Date().toISOString(),
            }),
          })
          .catch(() => {});
      } finally {
        busy = false;
      }
    });
  });
  app.post("/api/refresh", async (c) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || c.req.header("Authorization") !== `Bearer ${token}`)
      return c.json({ error: "Operator authorization required" }, 401);
    if (busy) return c.json({ error: "Another operation is active" }, 409);
    let sourceId: string | undefined;
    try {
      const b = z
        .object({ sourceId: z.string().max(100).optional() })
        .parse(await c.req.json());
      sourceId = b.sourceId;
    } catch {
      return c.json({ error: "Invalid refresh request" }, 400);
    }
    busy = true;
    try {
      return c.json(await refresh(sourceId));
    } catch {
      return c.json(
        {
          error:
            "Refresh failed; inspect corpus status for the last activated version",
        },
        500,
      );
    } finally {
      busy = false;
    }
  });
  app.use("/*", serveStatic({ root: "public" }));
  return app;
}
