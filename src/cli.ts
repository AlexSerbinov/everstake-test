import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { openDatabase } from "./storage/database.js";
import { createApplication } from "./application.js";
import {
  beginRun,
  finishRun,
  buildReceipt,
} from "./services/measurements/index.js";
import { readSources } from "./config.js";
import { refreshCorpus } from "./workflows/refresh-corpus.js";
import { embedCorpus } from "./services/search/hybrid-search.js";
import { runEvaluation } from "./services/evaluation/run-evaluation.js";
if (existsSync(".env")) loadEnvFile();
const db = openDatabase();
const app = createApplication(db);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "ask") {
    console.log(
      JSON.stringify(
        await app.ask(args.join(" "), (e) => {
          if (e.type !== "answer") console.log(JSON.stringify(e));
        }),
        null,
        2,
      ),
    );
  } else if (
    command === "refresh" ||
    command === "refresh-due" ||
    command === "refresh-resume"
  ) {
    console.log(
      JSON.stringify(
        await app.refresh(command === "refresh" ? args[0] : undefined, {
          due: command === "refresh-due",
          resumeJobId: command === "refresh-resume" ? args[0] : undefined,
        }),
        null,
        2,
      ),
    );
  } else if (command === "crawl") {
    const runId = beginRun(db, command, { sourceIds: args });
    try {
      const sources = readSources().filter(
        (s) => !args.length || args.includes(s.id),
      );
      if (!sources.length) throw new Error("No configured sources selected");
      const report = await refreshCorpus(db, sources, {
        crawl: {
          maxPages: Number(process.env.CRAWL_MAX_PAGES ?? 1000),
          concurrency: 3,
        },
        onProgress: (e) => console.log(JSON.stringify(e)),
      });
      mkdirSync("data/crawl-reports", { recursive: true });
      writeFileSync(
        `data/crawl-reports/${runId}.json`,
        JSON.stringify(report, null, 2),
      );
      mkdirSync("artifacts/corpus", { recursive: true });
      writeFileSync(
        `artifacts/corpus/${runId}.json`,
        JSON.stringify(
          {
            ...report,
            crawls: report.crawls.map(({ documents, ...r }) => ({
              ...r,
              acceptedDocuments: documents.map((d) => ({
                id: d.id,
                url: d.url,
                title: d.title,
                publishedAt: d.publishedAt,
                fetchedAt: d.fetchedAt,
              })),
            })),
          },
          null,
          2,
        ),
      );
      finishRun(db, runId, report.index ? "completed" : "incomplete");
      console.log(
        JSON.stringify({
          runId,
          index: report.index,
          failures: report.failures,
          receipt: buildReceipt(db, runId),
        }),
      );
    } catch (e) {
      finishRun(db, runId, "failed");
      throw e;
    }
  } else if (command === "index") {
    const id = beginRun(db, "index");
    try {
      const report = await embedCorpus(db, app.embeddings, id);
      finishRun(db, id, "completed");
      console.log(JSON.stringify({ report, receipt: buildReceipt(db, id) }));
    } catch (e) {
      finishRun(db, id, "failed");
      throw e;
    }
  } else if (command === "eval") {
    const mode = args[0] === "baseline" ? "baseline" : "agent";
    const ids = args.slice(1);
    console.log(
      JSON.stringify(
        await runEvaluation(
          db,
          (q, m) => app.ask(q, () => {}, m),
          mode,
          ids.length ? ids : undefined,
        ),
        null,
        2,
      ),
    );
  } else if (command === "costs")
    console.log(JSON.stringify(app.costs(), null, 2));
  else if (command === "stats")
    console.log(
      JSON.stringify({
        documents: db
          .prepare("SELECT count(*) AS count FROM documents WHERE active=1")
          .get(),
        chunks: db
          .prepare(
            "SELECT count(*) AS count FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.active=1",
          )
          .get(),
      }),
    );
  else
    console.log(
      "Commands: ask <question> | crawl [source IDs] | refresh [source ID] | refresh-due | refresh-resume <job ID> | index | eval agent|baseline [question IDs] | costs | stats",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
} finally {
  db.close();
}
