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
// CLI and HTTP use the same application services. Only argument parsing and output differ.
if (existsSync(".env")) loadEnvFile();
const db = openDatabase();
const app = createApplication(db);
const [command, ...args] = process.argv.slice(2);
try {
  await runCommand(command, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
} finally {
  db.close();
}

/** Dispatch first; keep longer collection and indexing steps below the command list. */
async function runCommand(
  command: string | undefined,
  args: string[],
): Promise<void> {
  switch (command) {
    case "ask":
      console.log(
        JSON.stringify(
          await app.ask(args.join(" "), (event) => {
            // The final answer is printed once below; progress still streams as it arrives.
            if (event.type !== "answer") console.log(JSON.stringify(event));
          }),
          null,
          2,
        ),
      );
      return;
    case "refresh":
    case "refresh-due":
    case "refresh-resume":
      if (command === "refresh-resume" && !args[0]?.trim())
        throw new Error("refresh-resume requires a job ID");
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
      return;
    case "crawl":
      await crawlSelectedSources(args);
      return;
    case "index":
      await indexCollectedDocuments();
      return;
    case "eval": {
      const mode = args[0] === "baseline" ? "baseline" : "agent";
      const questionSet = args.includes("--scenarios") ? "scenarios" : "core";
      const ids = args.slice(1).filter((arg) => arg !== "--scenarios");
      console.log(
        JSON.stringify(
          await runEvaluation(
            db,
            (question, selectedMode) =>
              app.ask(question, () => {}, selectedMode),
            mode,
            ids.length ? ids : undefined,
            questionSet,
          ),
          null,
          2,
        ),
      );
      return;
    }
    case "costs":
      console.log(JSON.stringify(app.costs(), null, 2));
      return;
    case "stats":
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
      return;
    default:
      console.log(
        "Commands: ask <question> | crawl [source IDs] | refresh [source ID] | refresh-due | refresh-resume <job ID> | index | eval agent|baseline [question IDs] | costs | stats",
      );
  }
}

/** Record collection failures as measured runs, even when no sources can be accepted. */
async function crawlSelectedSources(args: string[]): Promise<void> {
  const runId = beginRun(db, "crawl", { sourceIds: args });
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
}

/** Build missing vectors only; cached embeddings are reused by the indexer. */
async function indexCollectedDocuments(): Promise<void> {
  const id = beginRun(db, "index");
  try {
    const report = await embedCorpus(db, app.embeddings, id);
    finishRun(db, id, "completed");
    console.log(JSON.stringify({ report, receipt: buildReceipt(db, id) }));
  } catch (e) {
    finishRun(db, id, "failed");
    throw e;
  }
}
