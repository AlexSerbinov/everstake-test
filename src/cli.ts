// `npm run <command>` entry point. Each pipeline stage is its own command so it can be
// re-run alone; `pipeline` runs them in order.

import { crawl, crawlReport } from "./crawl/crawler.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? "true"]; }));
const positional = rest.filter((a) => !a.startsWith("--"));

async function main() {
  switch (cmd) {
    case "crawl": {
      if (flags.report) { console.table(crawlReport().bySource); console.table(crawlReport().byStatus); return; }
      await crawl({ force: flags.force === "true", only: flags.only });
      console.table(crawlReport().bySource);
      return;
    }
    case "dedup": { const { dedup } = await import("./index/dedup.js"); console.log(JSON.stringify(dedup(), null, 2)); return; }
    case "index": { const { buildIndex } = await import("./index/build.js"); await buildIndex({ force: flags.force === "true" }); return; }
    case "facts": { const { extractFacts } = await import("./index/facts.js"); await extractFacts({ force: flags.force === "true", limit: flags.limit ? Number(flags.limit) : undefined, urlLike: flags.url }); return; }
    case "ask": {
      const { ask } = await import("./ask/ask.js");
      const q = positional.join(" ");
      if (!q) { console.error('usage: npm run ask -- "question"'); process.exit(1); }
      const r = await ask(q);
      console.log(JSON.stringify(flags.trace ? r : { ...r, trace: undefined }, null, 2));
      return;
    }
    case "eval": {
      const { runEval, latestEval, renderEvalMd, metrics } = await import("./eval/run.js");
      if (flags.render) { // re-render EVAL.md from the latest results (after editing human_verdict)
        const run = latestEval(); if (!run) { console.error("no eval results"); process.exit(1); }
        run.metrics = metrics(run.rows);
        const fs = await import("node:fs"); const path = await import("node:path"); const { ROOT } = await import("./config.js");
        fs.writeFileSync(path.join(ROOT, "EVAL.md"), renderEvalMd(run)); console.log("EVAL.md re-rendered", run.metrics); return;
      }
      await runEval({ limit: flags.limit ? Number(flags.limit) : undefined, retryErrors: flags["retry-errors"] === "true" }); return;
    }
    case "cost": { const { costReport } = await import("./eval/cost.js"); console.log(costReport()); return; }
    case "stats": { const { stats } = await import("./ask/stats.js"); console.log(JSON.stringify(stats(), null, 2)); return; }
    case "pipeline": {
      await crawl({});
      const { dedup } = await import("./index/dedup.js"); dedup();
      const { buildIndex } = await import("./index/build.js"); await buildIndex({});
      const { extractFacts } = await import("./index/facts.js"); await extractFacts({});
      const { stats } = await import("./ask/stats.js"); console.log(JSON.stringify(stats(), null, 2));
      return;
    }
    default:
      console.log("commands: crawl [--force] [--only=<source>] [--report] | dedup | index [--force] | facts [--force] [--limit=N] | ask \"q\" [--trace] | eval [--limit=N] [--retry-errors] [--render] | cost | stats | pipeline");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
