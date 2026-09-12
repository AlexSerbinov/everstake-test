// What this system actually cost to build and what it costs to answer one question, read out
// of the database rather than estimated, plus the ×50 extrapolation the assignment asks for.
//
// PROVENANCE OF EVERY NUMBER HERE — this is the point of the module:
//   `llm_calls`     — one row written by src/llm.ts for every provider call ever made, with
//                     the token counts the provider reported and the cost computed from the
//                     price table. `by_stage`, the index cost and the token totals all come
//                     from this table, so they are measured, not modelled.
//   `questions_log` — one row per question asked through ask()/answerQuestion(), carrying the
//                     end-to-end cost of that question. `per_query.avg_cost_usd` is an average
//                     over this table, which is why it can differ slightly from summing
//                     `llm_calls` by stage: a question is several calls, and some calls
//                     (retries, judge) are attributed elsewhere.
//   one hardcoded estimate — `avg_embed_query_cost_usd`. Marked as such below.
//
// If this file is wrong, the cost section of REPORT.md is wrong; nothing else depends on it.
// The arithmetic is pinned in cost.test.ts against an in-memory database.

import { getConfig } from "../config.js";
import { all, one } from "../db.js";
import { machineLabel, stageRuns, type StageRunRow } from "../metrics.js";

/**
 * One 20-token query embedding at text-embedding-3-small prices is roughly $0.0000004.
 * Rounded up to $0.000001 and hardcoded rather than measured: query embeddings are not
 * separated by stage in `llm_calls`, and at four ten-thousandths of a cent the difference
 * is far below the rounding of every other figure in the report.
 */
const QUERY_EMBEDDING_COST_USD = 0.000001;

/** The assignment asks what a 50× larger corpus would cost. Only the corpus scales, not the query. */
const CORPUS_SCALE_FACTOR = 50;

/** Questions that reached a verdict. `error` rows are excluded — see `perQueryFigures`. */
const ANSWERED_STATUSES = "'answered','no_reliable_answer'";

interface StageRow {
  stage: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
  errors: number;
}

/**
 * Measured spend and the ×50 extrapolation. `asJson` returns the object the API and the eval
 * runner embed; otherwise the same numbers formatted for `npm run cost`.
 */
export function costReport(asJson = false) {
  const report = buildCostReport();
  if (asJson) return report;
  return renderCostText(report);
}

/**
 * The whole report. Two passes, because the last two sections describe the first ones: the
 * headline sentence and the measured/assumed lists are computed FROM the assembled figures, so
 * they cannot drift out of step with them the way hand-written prose does.
 */
function buildCostReport() {
  const figures = buildFigures();
  return { ...figures, headline: costHeadline(figures), honesty: measuredVsAssumed(figures) };
}

function buildFigures() {
  const byStage = all<StageRow>(
    `SELECT stage, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
      SUM(cache_read_tokens) cache_read_tokens, ROUND(SUM(cost_usd),5) cost_usd, ROUND(AVG(latency_ms)) avg_latency_ms, SUM(ok=0) errors
    FROM llm_calls GROUP BY stage, model ORDER BY stage`);

  /** Total spend of one pipeline stage, summed across whichever models served it. */
  const stageCost = (stage: string) =>
    byStage.filter((row) => row.stage === stage).reduce((sum, row) => sum + row.cost_usd, 0);
  /** Total of one token column for one stage. */
  const stageTokens = (stage: string, column: keyof StageRow) =>
    byStage.filter((row) => row.stage === stage)
      .reduce((sum, row) => sum + ((row[column] as number) ?? 0), 0);

  const corpus = corpusFigures();
  // Indexing = embeddings + the Haiku fact-extraction pass. Output tokens count for `facts`
  // because the extractor writes JSON back; `embed` has no output tokens at all.
  const indexCost = stageCost("embed") + stageCost("facts");
  const indexTokens =
    stageTokens("embed", "input_tokens") +
    stageTokens("facts", "input_tokens") +
    stageTokens("facts", "output_tokens");

  const perQuery = perQueryFigures(byStage, stageTokens);
  const extrapolation = extrapolateToLargerCorpus(
    corpus.canonical_documents, indexCost, indexTokens, perQuery.avg_cost_usd);

  return {
    corpus,
    index: {
      tokens: indexTokens,
      cost_usd: Number(indexCost.toFixed(5)),
      embed_cost_usd: Number(stageCost("embed").toFixed(5)),
      facts_cost_usd: Number(stageCost("facts").toFixed(5)),
    },
    per_query: perQuery,
    // The judge is what it cost to MEASURE the system, not to run it. Kept out of both the
    // index cost and the per-query cost so neither can be inflated by evaluation spend.
    eval_judge_cost_usd: Number(stageCost("judge").toFixed(5)),
    total_spent_usd: Number(byStage.reduce((sum, row) => sum + row.cost_usd, 0).toFixed(4)),
    by_stage: byStage,
    extrapolation_x50: extrapolation,
    // --- the resource half, added for COST.md and the UI's Cost view -----------------------
    // Everything below reads `stage_runs` (time, CPU, RAM, items, bytes) and joins it to
    // `llm_calls` by `run_id`. It is additive: every key above keeps its meaning, so EVAL.md,
    // the eval runner's embedded `cost_summary` and REPORT.md §3 are unaffected.
    machine: machineFigures(),
    prices: priceTable(),
    pipeline: pipelineStages(),
    receipt_example: exampleReceipt(),
  };
}

/** Corpus size, counting canonical documents apart from everything that was fetched. */
function corpusFigures() {
  const documents = one<{ canonical: number | null; fetched: number | null }>(
    `SELECT SUM(status='ok' AND duplicate_of IS NULL) canonical, SUM(status='ok') fetched FROM documents`);
  const chunks = one<{ n: number; chars: number | null }>(`SELECT COUNT(*) n, SUM(chars) chars FROM chunks`)!;
  return {
    canonical_documents: documents?.canonical ?? null,
    fetched_documents: documents?.fetched ?? null,
    chunks: chunks.n,
    chunk_chars: chunks.chars,
  };
}

/**
 * The cost of answering one question.
 *
 * `avg_cost_usd` comes from `questions_log` and deliberately excludes rows logged with an
 * `error` status: a question the provider never answered has a cost that is either zero or a
 * wasted retry, and averaging those in would misreport what a working question costs in
 * either direction. `questions_measured` is published alongside it so the exclusion is
 * visible and the denominator can be checked.
 *
 * The token averages come from `llm_calls` instead, divided by answer-stage CALLS rather than
 * by questions — the agent may make several answer calls for one question, and this figure is
 * about the size of one prompt, not the size of one question.
 */
function perQueryFigures(
  byStage: StageRow[],
  stageTokens: (stage: string, column: keyof StageRow) => number,
) {
  const questions = one<{ n: number; avg_cost: number | null; avg_latency: number | null }>(
    `SELECT COUNT(*) n, AVG(cost_usd) avg_cost, AVG(latency_ms) avg_latency
     FROM questions_log WHERE status IN (${ANSWERED_STATUSES})`)!;
  const answerCalls = byStage.filter((row) => row.stage === "answer");
  const totalAnswerCalls = answerCalls.reduce((sum, row) => sum + row.calls, 0);
  return {
    avg_cost_usd: Number((questions.avg_cost ?? 0).toFixed(5)),
    avg_input_tokens: answerCalls.length
      ? Math.round(stageTokens("answer", "input_tokens") / totalAnswerCalls) : 0,
    avg_output_tokens: answerCalls.length
      ? Math.round(stageTokens("answer", "output_tokens") / totalAnswerCalls) : 0,
    avg_embed_query_cost_usd: QUERY_EMBEDDING_COST_USD, // estimated, not measured — see the constant
    questions_measured: questions.n,
  };
}

/**
 * What a 50× corpus would cost. The load-bearing claim is what is NOT multiplied.
 *
 * LINEAR, so multiplied by 50: indexing. Every document is embedded once and passed through
 * the fact extractor once, so 50× the documents is 50× the embedding tokens and 50× the bill.
 *
 * NOT linear, so left alone: the per-query cost. The model always reads the same fixed top-k
 * chunks regardless of how many chunks exist, so the prompt does not grow. What grows is the
 * retrieval work (BM25 and cosine over 50× more rows), and that is in-process SQLite —
 * milliseconds, and free. Fact-ledger rows per key also grow, but the prompt caps them at 14.
 *
 * What this therefore does NOT model, and should not be read as claiming: retrieval QUALITY
 * at 50× (more near-duplicates competing for the same top-k), embedding storage, or the
 * re-crawl cost of keeping a 50× corpus fresh. It is a cost extrapolation, not a scaling proof.
 */
function extrapolateToLargerCorpus(
  canonicalDocuments: number | null,
  indexCost: number,
  indexTokens: number,
  perQueryCost: number,
) {
  const scaledIndexCost = indexCost * CORPUS_SCALE_FACTOR;
  return {
    documents: (canonicalDocuments ?? 0) * CORPUS_SCALE_FACTOR,
    index_cost_usd: Number(scaledIndexCost.toFixed(2)),
    index_tokens: indexTokens * CORPUS_SCALE_FACTOR,
    per_query_cost_usd: perQueryCost,
    per_1000_queries_usd: Number((perQueryCost * 1000).toFixed(2)),
    formula: `index: ${indexCost.toFixed(4)} USD × ${CORPUS_SCALE_FACTOR} = ${scaledIndexCost.toFixed(2)} USD; query: unchanged (top-k context is fixed; retrieval is O(chunks) in-process)`,
  };
}

/** The `npm run cost` console view. Same numbers as the JSON, laid out for a terminal. */
function renderCostText(report: ReturnType<typeof buildCostReport>): string {
  const { corpus, index, per_query: perQuery, extrapolation_x50: x50 } = report;
  return [
    `Corpus: ${corpus.canonical_documents} canonical documents (${corpus.fetched_documents} fetched), ${corpus.chunks} chunks`,
    `Index build: ${index.tokens.toLocaleString()} tokens → $${index.cost_usd} (embeddings $${index.embed_cost_usd} + fact extraction $${index.facts_cost_usd})`,
    `Per query: $${perQuery.avg_cost_usd} avg over ${perQuery.questions_measured} questions (~${perQuery.avg_input_tokens} in / ${perQuery.avg_output_tokens} out tokens)`,
    `Total spent so far: $${report.total_spent_usd}`,
    ``,
    `×${CORPUS_SCALE_FACTOR} corpus (${x50.documents} documents): index ≈ $${x50.index_cost_usd}; per query ≈ $${x50.per_query_cost_usd} (≈ $${x50.per_1000_queries_usd} per 1000 questions)`,
    `  ${x50.formula}`,
    ``,
    // Padded so the per-stage lines line up as columns in a terminal.
    ...report.by_stage.map((row) =>
      `  ${row.stage.padEnd(7)} ${row.model.padEnd(24)} calls=${String(row.calls).padStart(4)} in=${String(row.input_tokens).padStart(9)} out=${String(row.output_tokens).padStart(7)} cache=${String(row.cache_read_tokens).padStart(7)} $${row.cost_usd} err=${row.errors}`),
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// RESOURCES PER STAGE — the part of §5.6 that is not money
//
// Everything above answers "what did the models cost". Everything below answers "what did the
// stage cost": wall time, CPU, peak memory, items processed, bytes downloaded, and the money
// from `llm_calls` joined on `stage_runs.run_id` so the two halves cannot drift.
//
// The one thing to understand before reading: a model call is attributed to a stage in one of
// two ways, and the report always says which.
//   run_id  — the call was made inside a `withStageMetrics` wrapper, so it belongs to a run
//             with a measured start, end, CPU and RSS. This is the good case.
//   stage tag — the call predates `stage_runs` (every row written before this feature) or was
//             made outside a wrapper. Its money and tokens are real and are still counted,
//             attributed by the `llm_calls.stage` column, but there is no run behind it: no
//             wall time, no CPU, no RSS. Those cells read "not recovered", never 0.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline stage → the `llm_calls.stage` tags whose UNATTRIBUTED rows belong to it.
 *
 * Only used for rows with no `run_id`. Note `embed`: query embeddings also carry that tag, but
 * an unattributed embed row is overwhelmingly likely to be from an index build (283 of them
 * were), and a wrong guess here moves fractions of a cent. Attributed rows never come through
 * this map, so the guess disappears as the ledger fills with measured runs.
 */
const UNATTRIBUTED_LLM_STAGE_TO_PIPELINE: Record<string, PipelineStageId> = {
  embed: "index",
  facts: "facts",
  judge: "eval",
  agent: "question",
  answer: "question",
  classify: "question",
  other: "question",
};

export type PipelineStageId = "crawl" | "dedup" | "index" | "facts" | "eval" | "question";

/**
 * The rows of the stage table, in pipeline order, with the plain-language description each one
 * carries into COST.md and the UI. `scales` is the load-bearing field of the ×50 column: it
 * says whether a 50× corpus multiplies this row or leaves it alone, and `scaling_reason` says
 * why — the assignment asks for the arithmetic to be shown, and "×50" without a reason is not
 * arithmetic, it is a number.
 */
const PIPELINE_STAGES: {
  id: PipelineStageId;
  label: string;
  what_runs: "code" | "model" | "code + model";
  plain: string;
  scales: "linear" | "near-linear" | "constant";
  scaling_reason: string;
}[] = [
  {
    id: "crawl", label: "Crawl", what_runs: "code",
    plain: "Fetching pages politely, one host at a time, and storing the raw HTML.",
    scales: "linear",
    scaling_reason: "50× the pages at the same 500 ms delay per host. Free in money, and the only stage where wall time is a policy choice rather than a limit — parallelising across hosts would cut it without touching the bill.",
  },
  {
    id: "dedup", label: "Dedup", what_runs: "code",
    plain: "Folding copies of the same page into one canonical document (URL key → content hash → MinHash).",
    scales: "near-linear",
    scaling_reason: "Shingling and MinHash are O(documents); the candidate pairs come from LSH banding rather than an all-pairs comparison, so this stays close to linear instead of going quadratic.",
  },
  {
    id: "index", label: "Chunk & embed", what_runs: "code + model",
    plain: "Splitting documents into passages, stripping AI-directed sentences, and embedding every passage.",
    scales: "linear",
    scaling_reason: "Every chunk is embedded exactly once, so both the token count and the bill multiply by 50.",
  },
  {
    id: "facts", label: "Fact extraction", what_runs: "model",
    plain: "Reading each document with the cheap model and writing dated claims into the fact ledger.",
    scales: "linear",
    scaling_reason: "One model call per document, so 50× the documents is 50× the calls and 50× the bill. This is the row that dominates the index cost.",
  },
  {
    id: "eval", label: "Evaluation", what_runs: "model",
    plain: "Running the 20-question benchmark and grading the answers with a judge model.",
    scales: "constant",
    scaling_reason: "The benchmark has 20 questions whatever the corpus size. Its cost is the cost of measuring the system, not of running it.",
  },
  {
    id: "question", label: "One question", what_runs: "code + model",
    plain: "Answering one question: the agent loop, its tool calls, and the gates.",
    scales: "constant",
    scaling_reason: "The model always reads a fixed top-k (10 + 4 chunks, ≤14 fact rows), so the prompt does not grow with the corpus. What grows is in-process BM25 and cosine over more rows — milliseconds, and free.",
  },
];

/** The ×50 factor, shared with the extrapolation above so the two can never disagree. */
const SCALE = CORPUS_SCALE_FACTOR;

interface LlmGroup {
  run_id: string | null;
  stage: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  errors: number;
  first_ts: string;
  last_ts: string;
}

/**
 * Stages whose runs each do a DIFFERENT unit of work, so their runs are summed. Everything
 * else re-processes the same corpus on every run, so summing three crawls would claim 1 500
 * documents were fetched and three crawls' worth of money was the price of one index.
 */
const PER_ITEM_STAGES = new Set<PipelineStageId>(["question", "eval"]);

export interface PipelineStageSummary {
  id: PipelineStageId;
  label: string;
  what_runs: "code" | "model" | "code + model";
  plain: string;
  models: string[];
  /**
   * Which runs the figures below describe, spelled out because it is the difference between
   * "what one index build costs" and "what we have spent on index builds":
   *   "latest run"     — the most recent successful run of a stage that reprocesses the whole
   *                      corpus. This is the cost of doing it ONCE, which is the number that
   *                      belongs in a build estimate and in the ×50 column.
   *   "sum of runs"    — every measured run, for the stages where each run is a different
   *                      question or a different benchmark pass.
   *   "ledger tag only" — no run of this stage has ever been measured, so the money comes from
   *                      `llm_calls.stage` and there are no resource figures at all.
   */
  basis: "latest run" | "sum of runs" | "ledger tag only";
  /** How many times this stage has been recorded, successful or not. */
  runs: number;
  items: number | null;
  item_unit: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  /** The cost of the runs described by `basis` — one build, not every build ever attempted. */
  cost_usd: number;
  /** Everything ever spent under this stage, including superseded runs and experiments. */
  all_time_cost_usd: number;
  wall_ms: number | null;
  cpu_ms: number | null;
  peak_rss_bytes: number | null;
  bytes_in: number | null;
  cost_per_unit_usd: number | null;
  /** Money that arrived by stage tag rather than by `run_id`: real spend, no resources behind it. */
  unattributed_cost_usd: number;
  unattributed_calls: number;
  hosts: string[];
  x50: { cost_usd: number; wall_ms: number | null; scales: string; formula: string };
  runs_detail: {
    run_id: string; started_at: string; wall_ms: number | null; cpu_ms: number | null;
    peak_rss_bytes: number | null; items: number | null; item_unit: string | null;
    bytes_in: number | null; cost_usd: number; ok: number; host: string | null; error: string | null;
  }[];
}

/**
 * One row per pipeline stage: resources from `stage_runs`, money from `llm_calls`, joined on
 * `run_id`.
 *
 * The load-bearing decision is which runs a row describes — see `basis` above. Everything the
 * reader is likely to do with this table (estimate a rebuild, multiply by 50, divide by units)
 * wants the cost of ONE run, not the sum of every attempt, and the two differ by a lot here:
 * the embedding stage was run six times while an OpenAI rate limit was worked around, so its
 * all-time spend is five times what building the index once actually costs.
 */
export function pipelineStages(): PipelineStageSummary[] {
  const runsByStage = groupRunsByStage();
  const llmGroups = all<LlmGroup>(
    `SELECT run_id, stage, model, COUNT(*) calls, SUM(input_tokens) input_tokens,
            SUM(output_tokens) output_tokens, SUM(cache_read_tokens) cache_read_tokens,
            SUM(cost_usd) cost_usd, SUM(ok=0) errors, MIN(ts) first_ts, MAX(ts) last_ts
     FROM llm_calls GROUP BY run_id, stage, model`);

  const runIdToStage = new Map<string, PipelineStageId>();
  for (const [stageId, rows] of runsByStage) {
    for (const row of rows) runIdToStage.set(row.run_id, stageId);
  }

  return PIPELINE_STAGES.map((definition) => {
    const runs = runsByStage.get(definition.id) ?? [];
    const attributed = llmGroups.filter((group) => group.run_id && runIdToStage.get(group.run_id) === definition.id);
    const unattributed = llmGroups.filter((group) =>
      !group.run_id && UNATTRIBUTED_LLM_STAGE_TO_PIPELINE[group.stage] === definition.id);
    return summariseStage(definition, runs, attributed, unattributed);
  });
}

/** `stage_runs` grouped by stage id, ignoring stages COST.md has no row for (`pipeline`). */
function groupRunsByStage(): Map<PipelineStageId, StageRunRow[]> {
  const grouped = new Map<PipelineStageId, StageRunRow[]>();
  for (const row of stageRuns()) {
    const stageId = row.stage as PipelineStageId;
    if (!PIPELINE_STAGES.some((definition) => definition.id === stageId)) continue;
    if (!grouped.has(stageId)) grouped.set(stageId, []);
    grouped.get(stageId)!.push(row);
  }
  return grouped;
}

/**
 * Which runs this row describes. A stage that reprocesses the whole corpus is represented by
 * its most recent SUCCESSFUL run — the failed attempts stay visible in `runs_detail`, but a
 * crawl that died after 30 seconds is not part of what a crawl costs.
 */
function runsForBasis(stageId: PipelineStageId, runs: StageRunRow[]) {
  const successful = runs.filter((run) => run.ok && run.wall_ms != null);
  if (!successful.length) return { basis: "ledger tag only" as const, counted: [] as StageRunRow[] };
  if (PER_ITEM_STAGES.has(stageId)) return { basis: "sum of runs" as const, counted: successful };
  return { basis: "latest run" as const, counted: [successful.at(-1)!] };
}

function summariseStage(
  definition: (typeof PIPELINE_STAGES)[number],
  runs: StageRunRow[],
  attributed: LlmGroup[],
  unattributed: LlmGroup[],
): PipelineStageSummary {
  const sum = (rows: { [key: string]: any }[], column: string) =>
    rows.reduce((total, row) => total + (Number(row[column]) || 0), 0);

  const { basis, counted } = runsForBasis(definition.id, runs);
  const countedIds = new Set(counted.map((run) => run.run_id));
  // With no measured run, the row falls back to every ledger row tagged with this stage: the
  // money is still real, it simply has no run behind it. With one, only that run's calls count.
  const money: LlmGroup[] = basis === "ledger tag only"
    ? [...attributed, ...unattributed]
    : attributed.filter((group) => countedIds.has(group.run_id!));

  const costUsd = sum(money, "cost_usd");
  const items = counted.length
    ? counted.reduce((total, run) => total + (run.items ?? 0), 0) || null
    : null;

  return {
    id: definition.id,
    label: definition.label,
    what_runs: definition.what_runs,
    plain: definition.plain,
    models: [...new Set(money.map((group) => group.model))].sort(),
    basis,
    runs: runs.length,
    items,
    item_unit: counted.find((run) => run.item_unit)?.item_unit ?? runs.find((run) => run.item_unit)?.item_unit ?? null,
    tokens_in: sum(money, "input_tokens"),
    tokens_out: sum(money, "output_tokens"),
    cache_read: sum(money, "cache_read_tokens"),
    cost_usd: Number(costUsd.toFixed(5)),
    all_time_cost_usd: Number(sum([...attributed, ...unattributed], "cost_usd").toFixed(5)),
    wall_ms: counted.length ? sum(counted, "wall_ms") : null,
    cpu_ms: counted.length ? sum(counted, "cpu_user_ms") + sum(counted, "cpu_system_ms") : null,
    // A peak is a peak: the largest single sample, never a total of peaks.
    peak_rss_bytes: counted.length ? Math.max(...counted.map((run) => run.peak_rss_bytes ?? 0)) : null,
    bytes_in: counted.length ? sum(counted, "bytes_in") : null,
    cost_per_unit_usd: items ? Number((costUsd / items).toFixed(7)) : null,
    unattributed_cost_usd: Number(sum(unattributed, "cost_usd").toFixed(5)),
    unattributed_calls: sum(unattributed, "calls"),
    hosts: [...new Set(runs.map((run) => run.host).filter(Boolean) as string[])],
    x50: extrapolateStage(definition, costUsd, counted.length ? sum(counted, "wall_ms") : null,
      items ? Number((costUsd / items).toFixed(7)) : null),
    runs_detail: runs.map((run) => ({
      run_id: run.run_id,
      started_at: run.started_at,
      wall_ms: run.wall_ms,
      cpu_ms: run.cpu_user_ms == null ? null : (run.cpu_user_ms ?? 0) + (run.cpu_system_ms ?? 0),
      peak_rss_bytes: run.peak_rss_bytes,
      items: run.items,
      item_unit: run.item_unit,
      bytes_in: run.bytes_in,
      cost_usd: Number(
        attributed.filter((group) => group.run_id === run.run_id)
          .reduce((total, group) => total + group.cost_usd, 0).toFixed(6)),
      ok: run.ok,
      host: run.host,
      error: run.error,
    })),
  };
}

/**
 * The ×50 cell for one row, with the arithmetic spelled out next to the number.
 *
 * Three shapes, because three things are being said. A stage that scales states the
 * multiplication. A stage that does not states what stays the same and why — and for the
 * per-question row that is the cost of ONE question, not of the four that happen to have been
 * measured, since "what does a question cost at 50× the corpus" is the question being answered.
 * A stage that costs nothing says so in words: "$0.0000 × 50 = $0.00" is arithmetic nobody needs.
 */
function extrapolateStage(
  definition: (typeof PIPELINE_STAGES)[number],
  costUsd: number,
  wallMs: number | null,
  perUnitUsd: number | null,
): PipelineStageSummary["x50"] {
  const grows = definition.scales !== "constant";
  const scaled = grows ? costUsd * SCALE : costUsd;
  const timePart = wallMs == null ? "" : `; ${formatMs(wallMs)} × ${SCALE} = ${formatMs(wallMs * SCALE)}`;

  let formula: string;
  if (grows && costUsd === 0) {
    formula = `free at any size — no model is called${timePart ? `. Time, though: ${timePart.slice(2)}` : ""}. ${definition.scaling_reason}`;
  } else if (grows) {
    formula = `$${costUsd.toFixed(4)} × ${SCALE} = $${scaled.toFixed(2)}${timePart} — ${definition.scaling_reason}`;
  } else {
    const unchanged = definition.id === "question" && perUnitUsd != null
      ? `unchanged at ${formatUsd(perUnitUsd)} per question`
      : `unchanged at $${costUsd.toFixed(4)}`;
    formula = `${unchanged} — ${definition.scaling_reason}`;
  }

  return {
    cost_usd: Number((definition.id === "question" && perUnitUsd != null ? perUnitUsd : scaled).toFixed(6)),
    wall_ms: grows && wallMs != null ? wallMs * SCALE : wallMs,
    scales: definition.scales,
    formula,
  };
}

// --- machine, prices, example receipt --------------------------------------------------

/**
 * Which machine took these measurements. The money is machine-independent — a token costs the
 * same everywhere — but every time, CPU and memory figure in this report is a property of the
 * hardware it ran on, and a report that does not say so invites the reader to plan capacity
 * for a VPS using a laptop's numbers.
 */
function machineFigures() {
  const hosts = [...new Set(stageRuns().map((run) => run.host).filter(Boolean))] as string[];
  return {
    current: machineLabel(),
    hosts_that_measured: hosts,
    note: hosts.length > 1
      ? "More than one machine contributed runs; per-run rows carry their own host."
      : "All timings below were taken on this one machine. Money is hardware-independent; time, CPU and RAM are not.",
  };
}

/**
 * The price table exactly as the cost was computed from, plus the date it was copied.
 *
 * Published rather than merely used, because every dollar in this report is tokens × this
 * table: without it the figures are unfalsifiable, and with it a reader can recompute any row.
 * The dates come from the comments in `config/kb.yaml` and are the report's largest single
 * assumption — Gemini's intro rate is half its post-2026-12-31 price.
 */
function priceTable() {
  return {
    source: "config/kb.yaml → pricing_usd_per_mtok, USD per million tokens",
    copied_on: "2026-09 (Anthropic and OpenAI list prices; Gemini 3.x at the introductory rate valid until 2026-12-31, after which 3.8 Flash doubles to 1.50 / 7.50)",
    table: getConfig().pricing_usd_per_mtok,
  };
}

/**
 * A real question, broken down step by step — the assignment asks for exactly one, and it must
 * be a question that actually happened rather than a representative one.
 *
 * Picks the most recent answered question that has a receipt, so `npm run cost` after asking
 * something shows that something. A question that was refused by a gate is skipped only if an
 * answered one exists: an abstention is a legitimate receipt, but it makes a duller worked
 * example because the model turn that writes the answer is missing.
 */
function exampleReceipt() {
  const rows = all<{ question: string; ts: string; status: string; gate: string; response: string }>(
    `SELECT question, ts, status, response FROM questions_log
     WHERE response IS NOT NULL ORDER BY id DESC LIMIT 40`);

  const candidates = rows
    .map((row) => ({ row, parsed: safeJson(row.response) }))
    .filter((candidate) => candidate.parsed?.trace?.receipt?.rows?.length);
  if (!candidates.length) return null;

  // Prefer an answered question over a refused one — an abstention is a legitimate receipt but
  // makes a thin worked example, since the turn that writes the answer never happens — and
  // among those, the one with the most steps: the point of the section is to show what a full
  // agent run is made of, and a two-line receipt shows nothing a sentence could not.
  const answered = candidates.filter((candidate) => candidate.row.status === "answered");
  const pool = answered.length ? answered : candidates;
  const best = pool.reduce((widest, candidate) =>
    candidate.parsed.trace.receipt.rows.length > widest.parsed.trace.receipt.rows.length ? candidate : widest);

  return {
    question: best.row.question,
    asked_at: best.row.ts,
    status: best.row.status,
    gate: best.parsed.gate,
    ...best.parsed.trace.receipt,
  };
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

// --- COST.md ---------------------------------------------------------------------------

/** The assembled figures, before the headline and honesty sections are derived from them. */
type Figures = ReturnType<typeof buildFigures>;
/** The complete report object, as served by `GET /api/cost` and rendered into COST.md. */
type Report = ReturnType<typeof buildCostReport>;

/** Bytes → "41.2 MB". Report-facing only; nothing computes on the result. */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Milliseconds → "9m 41s" / "4.2 s" / "310 ms". */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Dollars, at whatever precision keeps a sub-cent figure from rounding to nothing. */
function formatUsd(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  // A real but tiny cost must not round to "$0.000000", which reads as free. Below a
  // millionth of a dollar the honest rendering is an upper bound.
  if (usd < 0.000001) return "<$0.000001";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const thousands = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US").replace(/,/g, " ");

/** "2 146 chunks" / "1 question" / "—". The singular matters: the runs table is mostly 1s. */
function formatUnits(items: number | null | undefined, unit: string | null | undefined): string {
  if (items == null) return "—";
  const name = items === 1 ? (unit ?? "").replace(/s$/, "") : (unit ?? "");
  return `${thousands(items)} ${name}`.trim();
}

/**
 * The headline sentence and the "where the money goes" line — both computed, never written by
 * hand, so they cannot survive the numbers changing underneath them.
 */
export function costHeadline(report: Figures) {
  const stages = report.pipeline;
  const buildStages = stages.filter((stage) => BUILD_STAGE_IDS.includes(stage.id));
  const buildCost = buildStages.reduce((total, stage) => total + stage.cost_usd, 0);
  const buildWallMs = buildStages.reduce((total, stage) => total + (stage.wall_ms ?? 0), 0) || null;

  // Two different per-question figures exist and they differ by 4×, so which one goes in the
  // headline is a real choice. `question.cost_per_unit_usd` is the measured cost of the
  // questions this build actually answered, on the model currently configured.
  // `per_query.avg_cost_usd` averages every question ever asked, including the Claude Opus 5
  // and Gemini 2.5 experiments — an average over three different systems, which is not the
  // cost of anything. The headline takes the first and publishes the second beside it.
  const questionStage = stages.find((stage) => stage.id === "question");
  const perQuestion = questionStage?.cost_per_unit_usd ?? report.per_query.avg_cost_usd;

  const costLeader = [...buildStages].sort((a, b) => b.cost_usd - a.cost_usd)[0];
  const timeLeader = [...buildStages].sort((a, b) => (b.wall_ms ?? 0) - (a.wall_ms ?? 0))[0];
  const share = (part: number, whole: number) => (whole ? Math.round(100 * part / whole) : 0);

  return {
    build_cost_usd: Number(buildCost.toFixed(4)),
    build_wall_ms: buildWallMs,
    per_question_usd: perQuestion,
    per_question_basis: questionStage?.items
      ? `measured over ${questionStage.items} question${questionStage.items === 1 ? "" : "s"} on the current model`
      : "no question has been measured yet",
    all_time_per_question_usd: report.per_query.avg_cost_usd,
    sentence: `Building the whole index cost ${formatUsd(buildCost)}. One question costs about ${formatUsd(perQuestion)}.`,
    where_the_money_goes:
      `${share(costLeader?.cost_usd ?? 0, buildCost)}% of the build cost is ${costLeader?.label.toLowerCase()}`
      + (buildWallMs
        ? `; ${share(timeLeader?.wall_ms ?? 0, buildWallMs)}% of the build time is ${timeLeader?.label.toLowerCase()}, because it is polite rather than slow.`
        : "."),
  };
}

/** The stages that make up "building the index". Running costs (eval, questions) are not. */
const BUILD_STAGE_IDS: PipelineStageId[] = ["crawl", "dedup", "index", "facts"];

/**
 * What is measured and what is assumed, as two explicit lists.
 *
 * This is the section that decides whether the rest of the document can be trusted, so it is
 * generated from the data rather than written once and left to rot: the "assumed" list grows a
 * line when unattributed spend exists, and loses it when every call has a run behind it.
 */
export function measuredVsAssumed(report: Figures) {
  const unattributed = report.pipeline.reduce((total, stage) => total + stage.unattributed_cost_usd, 0);
  const unmeasuredStages = report.pipeline.filter((stage) => stage.wall_ms == null).map((stage) => stage.label);

  const measured = [
    "Token counts — from the provider's own usage fields (`usageMetadata` for Gemini, `usage` for Anthropic and OpenAI), never estimated or counted locally.",
    "Wall time, CPU (user + system) and peak RSS — from `process.cpuUsage()` and sampled `process.memoryUsage.rss()`, recorded per stage run in `stage_runs`.",
    "Items and bytes — counted by the stages themselves: documents fetched, chunks embedded, questions answered, bytes read off the socket.",
    "Every dollar — tokens × the published price table, computed at call time and stored on the row, so no figure here depends on re-pricing old calls.",
  ];

  const assumed: string[] = [
    "Prices are list prices copied on the date above. Gemini 3.x is at its introductory rate until 2026-12-31; after that the answer model doubles and every per-question figure here doubles with it.",
    "The ×50 column assumes the corpus grows 50× while the *shape* of it does not: same page sizes, same duplicate rate, same proportion of documents worth extracting facts from.",
    "×50 wall time assumes the same machine and the same serial execution. Crawling is delay-bound rather than CPU-bound, so it parallelises across hosts; fact extraction already runs several documents at a time and would scale with concurrency, not with wall time.",
    "Peak RSS is process-wide and sampled every 250 ms: a spike shorter than that is missed, and a stage sharing the process with the HTTP server sees the server's memory too.",
    "The ×50 extrapolation is about cost, not about retrieval quality: 50× the chunks compete for the same fixed top-k, which is an answer-quality question this report does not model.",
  ];
  if (unattributed > 0) {
    assumed.push(
      `${formatUsd(unattributed)} of the total was logged before per-stage measurement existed. Its tokens and money are exact — they are ledger rows — but it is attributed to a stage by the \`llm_calls.stage\` tag rather than by a run id, and it carries no time, CPU or memory. Those cells read "—", not 0.`);
  }
  if (unmeasuredStages.length) {
    assumed.push(`Never yet run under measurement, so no time/CPU/RAM at all: ${unmeasuredStages.join(", ")}.`);
  }
  return { measured, assumed };
}

/**
 * Render COST.md. Everything in it comes from the report object, so the document cannot say
 * something the database does not — which is the whole reason it is generated by a command
 * instead of maintained by hand.
 */
export function renderCostMd(report: Report): string {
  const headline = costHeadline(report);
  const honesty = measuredVsAssumed(report);
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

  return [
    "# Measured cost and resources",
    "",
    `> Generated by \`npm run cost\` on ${generatedAt}. Every number is read out of \`data/kb.db\` —`,
    "> `llm_calls` for money and tokens, `stage_runs` for time, CPU, memory, items and bytes.",
    "> Nothing in this file is typed by hand; re-run the command and it is rebuilt.",
    "",
    `## ${headline.sentence}`,
    "",
    `${headline.where_the_money_goes}`,
    "",
    `- Corpus: **${report.corpus.canonical_documents} canonical documents** (${report.corpus.fetched_documents} fetched incl. duplicates), ${thousands(report.corpus.chunks)} chunks.`,
    `- Build (crawl → dedup → chunk & embed → facts): **${formatUsd(headline.build_cost_usd)}**${headline.build_wall_ms ? `, ${formatMs(headline.build_wall_ms)} of wall time` : ""}.`,
    `- One question: **${formatUsd(headline.per_question_usd)}** — ${headline.per_question_basis}.`
      + ` (The all-time average over all ${report.per_query.questions_measured} questions ever asked is ${formatUsd(headline.all_time_per_question_usd)}, but that mixes three different answer models across the project's history and is the cost of nothing in particular.)`,
    `- Everything ever spent on this project, including experiments, both providers and the eval judge: **${formatUsd(report.total_spent_usd)}**.`,
    "",
    `Measured on ${report.machine.current}. ${report.machine.note}`,
    "",
    "## 1. Per stage",
    "",
    "| Stage | What runs | Model | Units | Tokens in (cached) | Tokens out | Cost | Wall | CPU | Peak RSS | Downloaded | $ / unit |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...report.pipeline.map(stageTableRow),
    "",
    ...report.pipeline.flatMap(stageNotes),
    "",
    "## 2. One real question, step by step",
    "",
    ...receiptSection(report),
    "## 3. ×50 corpus, per row",
    "",
    `A corpus 50× this one is ≈ ${thousands((report.corpus.canonical_documents ?? 0) * SCALE)} canonical documents. Each row multiplies, or does not, for a stated reason.`,
    "",
    "| Stage | Now | ×50 | Scales | Arithmetic |",
    "|---|---|---|---|---|",
    ...report.pipeline.map((stage) =>
      `| ${stage.label} | ${formatUsd(stage.id === "question" && stage.cost_per_unit_usd != null ? stage.cost_per_unit_usd : stage.cost_usd)}${stage.wall_ms == null ? "" : ` · ${formatMs(stage.id === "question" && stage.items ? stage.wall_ms / stage.items : stage.wall_ms)}`} | ${formatUsd(stage.x50.cost_usd)}${stage.x50.wall_ms == null ? "" : ` · ${formatMs(stage.id === "question" && stage.items ? stage.x50.wall_ms / stage.items : stage.x50.wall_ms)}`} | ${stage.x50.scales} | ${stage.x50.formula} |`),
    "",
    `**Index build at ×50: ${formatUsd(report.pipeline.filter((stage) => BUILD_STAGE_IDS.includes(stage.id)).reduce((total, stage) => total + stage.x50.cost_usd, 0))}.** `
      + `**Per question at ×50: ${formatUsd(headline.per_question_usd)}, unchanged** — ${formatUsd(headline.per_question_usd * 1000)} per thousand questions.`,
    "",
    "## 4. What is measured, what is assumed",
    "",
    "**Measured**",
    "",
    ...honesty.measured.map((line) => `- ${line}`),
    "",
    "**Assumed**",
    "",
    ...honesty.assumed.map((line) => `- ${line}`),
    "",
    "## 5. Price table used",
    "",
    `${report.prices.source}. Copied ${report.prices.copied_on}.`,
    "",
    "| Model | Input | Output | Cache read | Cache write |",
    "|---|---|---|---|---|",
    ...Object.entries(report.prices.table).map(([model, price]: [string, any]) =>
      `| \`${model}\` | ${price.input} | ${price.output} | ${price.cache_read ?? "—"} | ${price.cache_write ?? "—"} |`),
    "",
    "## 6. Individual runs",
    "",
    "Every measured execution, so a single slow or failed run cannot hide inside an average.",
    "",
    "| Stage | Started | Wall | CPU | Peak RSS | Units | Downloaded | Cost | Host | Run id |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...report.pipeline.flatMap((stage) => stage.runs_detail.map((run) =>
      `| ${stage.label}${run.ok ? "" : " ⚠ failed"} | ${run.started_at.slice(0, 19).replace("T", " ")} | ${formatMs(run.wall_ms)} | ${formatMs(run.cpu_ms)} | ${formatBytes(run.peak_rss_bytes)} | ${formatUnits(run.items, run.item_unit)} | ${run.bytes_in ? formatBytes(run.bytes_in) : "—"} | ${formatUsd(run.cost_usd)} | ${(run.host ?? "—").split(" · ")[0]} | \`${run.run_id}\` |`)),
    "",
  ].join("\n");
}

/** One row of the per-stage table. */
function stageTableRow(stage: PipelineStageSummary): string {
  const cached = stage.cache_read ? ` (${thousands(stage.cache_read)} cached)` : "";
  const units = formatUnits(stage.items, stage.item_unit);
  return `| **${stage.label}** | ${stage.what_runs} | ${stage.models.length ? stage.models.map((m) => `\`${m}\``).join(", ") : "—"} `
    + `| ${units} | ${stage.tokens_in ? thousands(stage.tokens_in) + cached : "—"} | ${stage.tokens_out ? thousands(stage.tokens_out) : "—"} `
    + `| ${formatUsd(stage.cost_usd)} | ${formatMs(stage.wall_ms)} | ${formatMs(stage.cpu_ms)} | ${formatBytes(stage.peak_rss_bytes)} `
    + `| ${stage.bytes_in ? formatBytes(stage.bytes_in) : "—"} | ${stage.cost_per_unit_usd == null ? "—" : formatUsd(stage.cost_per_unit_usd)} |`;
}

/** The prose under the table: what the stage does, and any caveat this particular row carries. */
function stageNotes(stage: PipelineStageSummary): string[] {
  const caveats: string[] = [];
  if (stage.basis === "ledger tag only" && !stage.unattributed_calls) {
    caveats.push("Has not been run since per-stage measurement was added, and it calls no model, so there is nothing to report for it yet — run it once and this row fills in.");
  } else if (stage.basis === "ledger tag only") {
    caveats.push(`Never yet run under per-stage measurement: the ${formatUsd(stage.cost_usd)} and its ${stage.unattributed_calls} calls are exact ledger rows attributed by the \`llm_calls.stage\` tag, but no wall time, CPU or memory exists for them and none is invented.`);
  } else if (stage.basis === "latest run") {
    caveats.push(`Figures are the most recent complete run of ${stage.runs} recorded — what doing this ONCE costs.`
      + (stage.all_time_cost_usd > stage.cost_usd
        ? ` ${formatUsd(stage.all_time_cost_usd)} has been spent on this stage in total across every run and experiment; that is the project's history, not the price of an index.`
        : ""));
  } else {
    caveats.push(`Summed over ${stage.runs} measured runs, because each one is a different unit of work.`);
  }
  if (stage.id === "eval") caveats.push("Its wall time contains the questions it asked; those are counted again in their own row, so the two must not be added together.");
  return [`- **${stage.label}** — ${stage.plain} ${caveats.join(" ")}`];
}

/** Section 2: the worked example, or an honest note that no question has been asked yet. */
function receiptSection(report: Report): string[] {
  const receipt: any = report.receipt_example;
  if (!receipt) {
    return ["_No question has yet been answered under measurement. Ask one (`npm run ask -- \"…\"`) and re-run `npm run cost`._", ""];
  }
  const total = receipt.total;
  return [
    `**“${receipt.question}”** — asked ${receipt.asked_at.slice(0, 19).replace("T", " ")} UTC, verdict \`${receipt.status}\`${receipt.gate && receipt.gate !== "none" ? ` (gate \`${receipt.gate}\`)` : ""}.`,
    "",
    "| # | Step | Runs on | Tokens in (cached) | Out | Cost | Time |",
    "|---|---|---|---|---|---|---|",
    ...receipt.rows.map((row: any) =>
      `| ${row.n} | ${row.label}${row.failed ? " ⚠ failed" : ""} | ${row.detail} | ${row.tokens_in ? thousands(row.tokens_in) + (row.cache_read ? ` (${thousands(row.cache_read)})` : "") : "—"} | ${row.tokens_out ? thousands(row.tokens_out) : "—"} | ${row.usd ? formatUsd(row.usd) : "$0"} | ${formatMs(row.ms)}${row.nested ? " *" : ""} |`),
    `| | **Total** | ${total.model_calls} model calls, ${total.tool_calls} tool calls | **${thousands(total.tokens_in)}${total.cache_read ? ` (${thousands(total.cache_read)})` : ""}** | **${thousands(total.tokens_out)}** | **${formatUsd(total.usd)}** | **${formatMs(total.wall_ms)}** |`,
    "",
    // The footnote only exists when there is a nested row to explain; printing it regardless
    // would leave a dangling "its — is already counted there".
    ...(receipt.rows.some((row: any) => row.nested)
      ? [`\\* the query embedding runs inside the search step above it, so its ${formatMs(receipt.rows.find((row: any) => row.nested).ms)} is already counted there and left out of the total.`]
      : []),
    `Steps account for ${formatMs(total.accounted_ms)} of the ${formatMs(total.wall_ms)}; the other ${formatMs(total.unaccounted_ms)} is orchestration — SQLite writes, JSON, the gates.`,
    "",
    "The total is not a running counter kept by the agent: it is the sum of the `llm_calls` rows this question's stage run wrote, re-read from the database. If it were accumulated separately it could disagree with the ledger, and then neither number would be worth printing.",
    "",
  ];
}
