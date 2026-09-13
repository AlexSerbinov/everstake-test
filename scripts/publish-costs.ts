import { mkdirSync, writeFileSync } from "node:fs";
import { openDatabase, getSetting } from "../src/storage/database.js";
import {
  buildReceipt,
  costOverview,
} from "../src/services/measurements/index.js";
const db = openDatabase();
try {
  const calls = db
    .prepare(
      "SELECT id,run_id,stage,provider,model,started_at,elapsed_ms,input_tokens,output_tokens,cost_usd,status,metadata FROM api_calls ORDER BY started_at,rowid",
    )
    .all();
  const index = calls.filter((c) => c.stage === "index");
  const indexTokens = index.reduce(
    (sum, c) => sum + Number(c.input_tokens ?? 0),
    0,
  );
  const indexCost = index.reduce((sum, c) => sum + Number(c.cost_usd ?? 0), 0);
  const indexUnknown = index.filter((c) => c.cost_usd === null).length;
  const stt = calls.filter((c) => c.stage === "youtube-transcription");
  const sttKnown = stt.reduce((sum, c) => sum + Number(c.cost_usd ?? 0), 0);
  const reviewed = calls.filter((c) => c.stage === "youtube-speaker-review");
  const durations = new Map(
    stt.map((c) => {
      const m = JSON.parse(String(c.metadata));
      return [String(m.videoId), Number(m.durationSeconds ?? 0)] as const;
    }),
  );
  const videoSeconds = [...durations.values()].reduce((a, b) => a + b, 0);
  const videoKnown = reviewed.reduce(
    (sum, c) => sum + Number(c.cost_usd ?? 0),
    0,
  );
  const videoForecast = stt.reduce(
    (sum, c) =>
      sum + Number(JSON.parse(String(c.metadata)).forecastCostUsd ?? 0),
    0,
  );
  const videoDocuments = Number(
    db
      .prepare(
        "SELECT count(*) n FROM documents WHERE active=1 AND json_extract(snapshot,'$.kind')='youtube'",
      )
      .get()!.n,
  );
  const all = costOverview(db);
  const known = calls.reduce((sum, c) => sum + Number(c.cost_usd ?? 0), 0);
  const unknown = calls.filter((c) => c.cost_usd === null).length;
  const documents = Number(
    db.prepare("SELECT count(*) n FROM documents WHERE active=1").get()!.n,
  );
  const runs = db
    .prepare("SELECT id,kind,started_at,status FROM runs ORDER BY started_at")
    .all()
    .map((r) => ({ ...r, receipt: buildReceipt(db, String(r.id)) }));
  mkdirSync("costs", { recursive: true });
  writeFileSync(
    "costs/measured-ledger.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope:
          "This TypeScript rebuild only; prior prototype spending is not imported",
        corpusVersion: getSetting(db, "corpus_version"),
        overview: all,
        runs,
        calls: calls.map(({ metadata, ...c }) => {
          const m = JSON.parse(String(metadata));
          return {
            ...c,
            prices: m.price ?? m.priceSnapshot ?? null,
            reservationUsd: m.reservationUsd ?? null,
          };
        }),
      },
      null,
      2,
    ),
  );
  const evals = db
    .prepare("SELECT result FROM evaluations ORDER BY created_at")
    .all()
    .map((r) => JSON.parse(String(r.result)))
    .filter((r) => r.plannedTotal === 20 && r.rows.length === 20);
  const costsPageUrl =
    "https://everstate-knowledge-base.89-167-19-222.sslip.io/#costs";
  const latestAgent = [...evals].reverse().find((r) => r.mode === "agent");
  const latestBaseline = [...evals]
    .reverse()
    .find((r) => r.mode === "baseline");
  const perQuery = latestAgent ? latestAgent.summary.knownCostUsd / 20 : null;
  const perQueryLine = latestAgent
    ? `**$${perQuery!.toFixed(6)}** on average: latest agent run \`${latestAgent.id}\`, $${latestAgent.summary.knownCostUsd.toFixed(6)} / 20 questions${latestBaseline ? `. Baseline (one retrieval, one prompt): $${(latestBaseline.summary.knownCostUsd / 20).toFixed(6)}` : ""}`
    : "no complete 20-question run recorded";
  // Context size and tool steps are capped, so a query is carried over at ×1, not ×50.
  const queryRow =
    perQuery === null
      ? ""
      : `| One query | $${perQuery.toFixed(6)} | × 1 | $${perQuery.toFixed(6)} |\n`;
  let text = `# Measured API costs\n\n> **Easier to read on the live site:** [Costs page](${costsPageUrl}) shows the same ledger with provider panels, per-answer receipts and filters. This file is the committed copy for review.\n\n## §5.6 at a glance\n\n| What is asked | Measured value |\n|---|---|\n| Tokens used to build the index | **${indexTokens.toLocaleString("en-US")}** input tokens across ${index.length} embedding calls |\n| Actual cost of building the index | **$${indexCost.toFixed(6)}** known; ${indexUnknown} failed attempts have no provider price |\n| Cost of one query | ${perQueryLine} |\n| All API spending of this rebuild | **$${known.toFixed(6)}** known; ${unknown} calls with unknown cost |\n\n### 50× larger corpus: arithmetic\n\n| Item | Measured now | Factor | Expected at 50× |\n|---|---:|---:|---:|\n| Documents | ${documents.toLocaleString("en-US")} | × 50 | ${(documents * 50).toLocaleString("en-US")} |\n| Index tokens | ${indexTokens.toLocaleString("en-US")} | × 50 | ${(indexTokens * 50).toLocaleString("en-US")} |\n| Index cost | $${indexCost.toFixed(6)} | × 50 | $${(indexCost * 50).toFixed(6)} |\n${queryRow}\nThe index scales with the corpus. A query does not: context size and tool steps are capped, so the per-query cost is carried over unchanged and must be remeasured on the larger corpus. Details and limits are in the [extrapolation section](#50-extrapolation--assumptions-not-measured-production-results) below.\n\nScope: this TypeScript rebuild, from provider probes through collection, indexing, YouTube, diagnostic questions and final evaluations. Prior Claude/Codex totals are historical and are not added to these runs. Subscription agent effort, existing server rental and bandwidth are not provider-token charges.\n\n**Known usage-priced / provider-reported total: $${known.toFixed(6)}; ${unknown} calls have unknown actual cost.** This is not an invoice-reconciled grand total. Unknown values stay null in the ledger and UI; forecasts/reservations are shown separately. [Full measured ledger](costs/measured-ledger.json).\n\n| Operation | Calls | Input tokens | Output tokens | Known cost | Unknown cost calls |\n|---|---:|---:|---:|---:|---:|\n`;
  for (const stage of [...new Set(calls.map((c) => String(c.stage)))]) {
    const rows = calls.filter((c) => c.stage === stage);
    text += `| ${stage} | ${rows.length} | ${rows.reduce((n, c) => n + Number(c.input_tokens ?? 0), 0)} | ${rows.reduce((n, c) => n + Number(c.output_tokens ?? 0), 0)} | $${rows.reduce((n, c) => n + Number(c.cost_usd ?? 0), 0).toFixed(6)} | ${rows.filter((c) => c.cost_usd === null).length} |\n`;
  }
  text +=
    "\nEach attempt is written before the external request. Successful, retried, timed-out and invalid-content calls retain their usage. Soniox costs are reconciled against matching provider usage logs when available; its input token count includes audio and text, with the separate counts retained in the YouTube ledger. For model calls, native provider usage supplies tokens; a dated price table in `config/models.yaml` converts usage to cost. Cached-input and thinking tokens are handled without counting them twice. Parent receipts aggregate descendant calls once. HTTP failures without usage remain unknown rather than being silently priced at zero, and so do attempts cancelled by a stopped request: the provider may still bill the interrupted call.\n\n## Index build and every evaluation run\n\n";
  text += `Building and repairing the index consumed **${indexTokens.toLocaleString("en-US")} measured input tokens**, costing **$${indexCost.toFixed(6)} known**, with ${indexUnknown} unpriced failed attempts. This includes the initial web build and changed/new transcript chunks; cached embeddings were reused on resume. The final corpus has ${documents} documents. The temporary embedding rate limit and the resumed run remain visible.\n\n`;
  for (const run of evals) {
    const latencies = run.rows
      .map((r: any) => r.answer.receipt.elapsedMs)
      .sort((a: number, b: number) => a - b);
    text += `- ${run.mode} run \`${run.id}\`: $${run.summary.knownCostUsd.toFixed(6)} known / 20 = **$${(run.summary.knownCostUsd / 20).toFixed(6)} per query on average**; ${run.summary.unknownCalls} unknown calls. Median latency ${(latencies[Math.floor(latencies.length / 2)] / 1000).toFixed(1)}s; p95 ${(latencies[Math.ceil(latencies.length * 0.95) - 1] / 1000).toFixed(1)}s.\n`;
  }
  text += `\n## 50× extrapolation — assumptions, not measured production results\n\nAt the same average document/chunk length and embedding price, ${documents} × 50 = **${documents * 50} documents**. Measured build tokens ${indexTokens} × 50 = **${indexTokens * 50} tokens**. Known embedding cost $${indexCost.toFixed(6)} × 50 = **$${(indexCost * 50).toFixed(6)}**, excluding unresolved charges. This scales the observed build, including its reprocessing overhead; a clean first build can differ.\n\nQuery model context and tool steps remain capped, so LLM input cost is not assumed to grow 50× merely because the corpus does. It must be remeasured: harder retrieval may need more calls. The current exact vector scan and JSON vectors will grow substantially in CPU, RAM and latency; an approximate vector index and incremental scheduling would be the first scale changes. No claim is made that this demo sustains 50× data at the same latency.\n\n## YouTube\n\n${durations.size} videos totaling ${videoSeconds.toLocaleString("en-US")} seconds (${(videoSeconds / 3600).toFixed(3)} hours) were submitted for transcription. Gemini has ${reviewed.length} measured speaker-review attempts, known cost $${videoKnown.toFixed(6)}. ${stt.filter((c) => c.cost_usd === null).length} transcription charges remain unknown. Soniox provider-reported known cost is **$${sttKnown.toFixed(6)}**; matching uses the recorded operation and transcription IDs. The recorded transcription forecast totals **$${videoForecast.toFixed(6)}**, using duration / 3,600 × the configured $0.10/hour assumption, not a measured invoice. ${videoDocuments} transcripts are active in the corpus; only eligible attributed testimony is active; uncertain attributions and recordings without qualifying testimony remain outside the index. The full inventory and outstanding work are in [costs/YouTube](costs/YouTube/README.md).\n\nReserving a conservative amount before a call limits further work; it is not a guarantee of an external provider's final bill. Public demo calls have a per-run limit and a process-session ceiling. Restarting the process starts a new session budget.\n`;
  writeFileSync("COST.md", text);
  console.log(
    JSON.stringify({
      knownCostUsd: known,
      unknownCalls: unknown,
      indexTokens,
      indexKnownCostUsd: indexCost,
      documents,
    }),
  );
} finally {
  db.close();
}
