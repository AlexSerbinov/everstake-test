// `npm run <command>` entry point — the operator-facing face of the pipeline.
//
// Each stage is its own command (crawl → dedup → index → facts → ask → eval) so it can be
// re-run alone: crawling is slow and rate-limited, fact extraction costs real money, and
// nothing about a bad chunking parameter should force a re-crawl. `pipeline` runs them in
// order for a clean machine.
//
// What breaks if this is wrong: the command names are the public contract. They appear in
// `package.json` scripts, in `scripts/deploy.sh`, in the README and in the report, so
// renaming one silently breaks the documented way to reproduce every number we claim.
//
// Two conventions worth knowing before reading the handlers:
//  - every stage module is imported dynamically, inside its own handler, so that `npm run
//    stats` does not pay for loading cheerio, the Anthropic SDK and the eval harness;
//  - handlers print and return; only the process-level catch at the bottom sets an exit code
//    (plus `adversarial`, which fails CI deliberately).

import { crawl, crawlReport } from "./crawl/crawler.js";
import { withStageMetrics } from "./metrics.js";

const USAGE = "commands: crawl [--force] [--only=<source>] [--report] | dedup | index [--force] | facts [--force] [--limit=N] | ask \"q\" [--trace] [--single-shot] | eval [--limit=N] [--engine=agent|single] [--retry-errors] [--only=q01,q15] [--render] | adversarial [--only=a01,p03] [--keep-db] [--render] | cost | stats | pipeline";

const [command, ...args] = process.argv.slice(2);
const flags = parseFlags(args);
const positional = args.filter((arg) => !arg.startsWith("--"));

/**
 * `--name=value` → `{ name: "value" }`, and a bare `--name` → `{ name: "true" }`.
 * Values stay strings, so every handler that wants a number or a boolean converts explicitly
 * (`flags.force === "true"`, `Number(flags.limit)`) — that is why a flag is compared against
 * the string "true" throughout this file rather than tested for truthiness.
 * Only the first `=` splits, so a value may not itself contain one; no current flag does.
 */
function parseFlags(argv: string[]): Record<string, string> {
  const pairs = argv
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [name, value] = arg.slice(2).split("=");
      return [name, value ?? "true"] as const;
    });
  return Object.fromEntries(pairs);
}

/** Fetch the corpus defined in `config/sources.yaml`. `--report` prints the last crawl's
 *  tally without touching the network, which is the usual way to check what a run produced. */
async function runCrawl() {
  if (flags.report) {
    const report = crawlReport();
    console.table(report.bySource);
    console.table(report.byStatus);
    return;
  }
  await withStageMetrics("crawl", async (stage) => {
    const stats = await crawl({ force: flags.force === "true", only: flags.only });
    stage.items(stats.fetched, "documents");
    stage.meta({ ...stats });
  }, { flags });
  console.table(crawlReport().bySource);
}

/** Mark near-duplicate documents as aliases of a canonical one. Prints the JSON summary
 *  because the counts per method (url / hash / minhash) are what the report quotes. */
async function runDedup() {
  const { dedup } = await import("./index/dedup.js");
  const report = await withStageMetrics("dedup", (stage) => {
    const result = dedup();
    stage.items(result.documents, "documents");
    stage.meta({ clusters: result.clusters, aliases: result.aliases, by_method: result.by_method });
    return result;
  });
  console.log(JSON.stringify(report, null, 2));
}

/** Chunk the canonical documents, strip injected instructions, embed. `--force` re-indexes
 *  documents that already have chunks — needed after any chunking or filter change. */
async function runIndex() {
  const { buildIndex } = await import("./index/build.js");
  await withStageMetrics("index", async (stage) => {
    const stats = await buildIndex({ force: flags.force === "true" });
    // Chunks, not documents: chunking and embedding both scale with chunks, and the $/unit
    // column in COST.md is only meaningful against the unit the work is actually done in.
    stage.items(stats.chunks || stats.embedded, "chunks");
    stage.meta({ ...stats });
  }, { flags });
}

/** Extract the dated fact ledger with the cheap model. `--limit` and `--url` exist because
 *  this is the one stage that costs a few dollars: they make a partial re-run affordable. */
async function runFacts() {
  const { extractFacts } = await import("./index/facts.js");
  await withStageMetrics("facts", async (stage) => {
    const stats = await extractFacts({
      force: flags.force === "true",
      limit: flags.limit ? Number(flags.limit) : undefined,
      urlLike: flags.url,
    });
    stage.items(stats.documents, "documents");
    stage.meta(stats);
  }, { flags });
}

/** Answer one question and print the full JSON response (answer, citations, gates, cost). */
async function runAsk() {
  const question = positional.join(" ");
  if (!question) {
    console.error('usage: npm run ask -- "question"');
    process.exit(1);
  }
  // Default is the agent (single-shot on non-Gemini providers); --single-shot forces the old path.
  const { answerQuestion } = await import("./ask/agent.js");
  const { ask } = await import("./ask/ask.js");
  // `answerQuestion` opens its own measured stage run; the forced single-shot path is wrapped
  // here so that it, too, produces a `stage_runs` row and a receipt.
  const result = flags["single-shot"]
    ? await withStageMetrics("question", (stage) => { stage.items(1, "questions"); return ask(question); }, { question })
    : await answerQuestion(question, traceListener());
  // Without --trace the trace is dropped from the printed JSON: it is hundreds of lines of
  // tool arguments and would bury the answer.
  console.log(JSON.stringify(flags.trace ? result : { ...result, trace: undefined }, null, 2));
}

/** With --trace, print each pipeline event to stderr as it happens so the loop is visible
 *  live rather than only in the JSON at the end. stderr, so `npm run ask | jq` still works. */
function traceListener() {
  if (!flags.trace) return undefined;
  return (event: { event: string; data: any }) => {
    // `final` carries the whole answer and is printed by the caller anyway.
    if (event.event === "final") return;
    console.error(`  · ${event.event.padEnd(11)} ${JSON.stringify(event.data).slice(0, 160)}`);
  };
}

/** The 20-question evaluation. `--render` skips the run entirely and rebuilds EVAL.md from
 *  the stored results — that is how a hand-edited `human_verdict` gets into the metrics
 *  without paying for the questions again.
 *
 *  The recomputed metrics are written back into the results JSON as well as into EVAL.md.
 *  They must not diverge: `GET /api/eval` serves the JSON, so leaving it stale makes the
 *  live UI report different accuracy from the file the reviewer is reading. */
async function runEval() {
  const { runEval: execute, latestEval, renderEvalMd, metrics, saveEvalRun } = await import("./eval/run.js");
  if (flags.render) {
    const previous = latestEval();
    if (!previous) {
      console.error("no eval results");
      process.exit(1);
    }
    previous.metrics = metrics(previous.rows);
    saveEvalRun(previous);
    await writeReport("EVAL.md", renderEvalMd(previous));
    console.log("EVAL.md re-rendered", previous.metrics);
    return;
  }
  // Two spellings of the same choice: `--engine=single` is the documented one, `--single-shot`
  // matches the flag `ask` uses, and either selects the pre-agent path.
  const useSingleShot = flags.engine === "single" || flags["single-shot"] === "true";
  const engine = useSingleShot ? "single" as const : "agent" as const;
  // Nested stage runs: each question inside opens its own `question` run, so the judge calls
  // logged here belong to the eval run while the answers belong to their questions. The eval
  // row's wall time therefore CONTAINS the questions' — said out loud in COST.md rather than
  // netted off, because "how long does evaluating cost me" is the wall-clock question.
  await withStageMetrics("eval", async (stage) => {
    const result = await execute({
      limit: flags.limit ? Number(flags.limit) : undefined,
      retryErrors: flags["retry-errors"] === "true",
      only: flags.only ? String(flags.only).split(",") : undefined,
      engine,
    });
    stage.items(result?.rows?.length ?? 0, "questions");
    stage.meta({ engine, metrics: result?.metrics });
  }, { flags });
}

/** The prompt-injection / poisoned-corpus suite. Runs against a copy of the index with
 *  hostile documents planted in it, so the real corpus is never modified. */
async function runAdversarial() {
  const { runAdversarial: execute, latestAdversarial, renderAdversarialMd } = await import("./eval/adversarial.js");
  if (flags.render) {
    const previous = latestAdversarial();
    if (!previous) {
      console.error("no adversarial results");
      process.exit(1);
    }
    await writeReport("ADVERSARIAL.md", renderAdversarialMd(previous));
    console.log("ADVERSARIAL.md re-rendered", previous.summary);
    return;
  }
  const result = await withStageMetrics("adversarial", async (stage) => {
    const run = await execute({
      only: flags.only ? String(flags.only).split(",") : undefined,
      keepDb: flags["keep-db"] === "true",
    });
    stage.items(run.rows?.length ?? 0, "attacks");
    stage.meta(run.summary);
    return run;
  }, { flags });
  if (result.summary.failed) process.exitCode = 1;   // red CI on any hard failure or canary hit
}

/** Write a generated markdown report to the project root. `fs` and `path` are imported here
 *  rather than at the top of the file so the common commands do not load them. */
async function writeReport(filename: string, markdown: string) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { ROOT } = await import("./config.js");
  fs.writeFileSync(path.join(ROOT, filename), markdown);
}

/**
 * Measured spend and resources, and the ×50 extrapolation quoted in REPORT.md §3.
 *
 * Prints the short console view and (re)writes `COST.md`, which is the committed artefact: the
 * report has to be regenerable from the database by one command, or the day someone edits a
 * number by hand it stops being measured.
 */
async function runCost() {
  const { costReport, renderCostMd } = await import("./eval/cost.js");
  const report = costReport(true);
  await writeReport("COST.md", renderCostMd(report as any));
  console.log(costReport());
  console.log("\nCOST.md written");
}

/** Corpus health: document, chunk, fact and instruction counts. */
async function runStats() {
  const { stats } = await import("./ask/stats.js");
  console.log(JSON.stringify(stats(), null, 2));
}

/** Everything, in dependency order, with default options — the cold-start path.
 *  Each stage reads what the previous one wrote, so the order here is not cosmetic. */
async function runPipeline() {
  // Each stage measures itself through its own CLI handler, and the whole thing is wrapped once
  // more so COST.md can state the end-to-end cold-start time next to the sum of its parts.
  await withStageMetrics("pipeline", async () => {
    await runCrawl();
    await runDedup();
    await runIndex();
    await runFacts();
  });
  const { stats } = await import("./ask/stats.js");
  console.log(JSON.stringify(stats(), null, 2));
}

const COMMANDS: Record<string, () => Promise<void>> = {
  crawl: runCrawl,
  dedup: runDedup,
  index: runIndex,
  facts: runFacts,
  ask: runAsk,
  eval: runEval,
  adversarial: runAdversarial,
  cost: runCost,
  stats: runStats,
  pipeline: runPipeline,
};

async function main() {
  // `Object.hasOwn`, not a plain lookup: without it `npm run cli -- toString` would find
  // Object.prototype.toString and try to run it as a stage.
  const handler = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) {
    console.log(USAGE);
    return;
  }
  await handler();
}

// Any unhandled rejection in a stage is a failed run: print the whole error (stack included —
// this is an operator tool, not a user-facing CLI) and exit non-zero so CI and shell `&&` see it.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
