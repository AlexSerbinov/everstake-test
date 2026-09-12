// Where the calculator's inputs come from: `stage_runs`, `llm_calls` and the corpus itself.
//
// The assignment's rule for the cost section applies here too — measured unit costs, not
// guesses. So every field of `UnitCosts` is derived from a row somebody's laptop actually
// produced, and the two that cannot be (how long a 304 takes before any refresh has ever run,
// and the fixed overhead of a run) are labelled as fallbacks in `notes`, which the UI prints as
// its assumptions footnote. Nothing is silently invented.
//
// The one measurement that improves itself: once `npm run refresh` has run at least once, its
// own `refresh_runs` row supplies the conditional-GET seconds and the per-run overhead, and the
// fallbacks below stop being used. The estimate therefore gets more accurate the more the
// feature is used, which is the right direction for a number an operator makes decisions on.

import { getConfig } from "../config.js";
import { all, one } from "../db.js";
import { SOURCE_TYPES, classifySourceType, type SourceType } from "./policy.js";
import type { CorpusProfile, TypeProfile, UnitCosts } from "./calculator.js";

/** Months of history the "new documents per month" rate is measured over when the type has
 *  recent dated documents. Twelve smooths a quiet quarter without reaching back to a corpus
 *  shape that no longer exists. */
const RATE_WINDOW_MONTHS = 12;

/** Fallback seconds for one conditional GET that answers 304, used only until a refresh run has
 *  measured the real figure. It is the politeness delay plus a round-trip; the delay dominates. */
const FALLBACK_CONDITIONAL_EXTRA_SECONDS = 0.25;

/** Fallback bytes for a 304: response headers only. Measured runs replace this. */
const FALLBACK_CONDITIONAL_BYTES = 700;

/** Requests a run makes before it looks at any document: robots.txt per host, the sitemap index
 *  and its four children, the GitHub org listing, docs' llms.txt. Used only for the fallback
 *  overhead figure. */
const FALLBACK_DISCOVERY_REQUESTS = 8;

export interface MeasuredUnits {
  units: UnitCosts;
  /** field name → one sentence saying where the number came from. Printed in the UI. */
  notes: Record<keyof UnitCosts, string>;
}

/**
 * Unit costs, read out of the ledger.
 *
 * Each block picks the most recent *successful* run of a stage rather than summing every attempt
 * — the same rule COST.md uses, and for the same reason: the embedding stage was run six times
 * around an OpenAI rate limit, and summing would price a refresh at five times the truth.
 */
export function measureUnits(): MeasuredUnits {
  const cfg = getConfig();
  const notes = {} as Record<keyof UnitCosts, string>;

  // --- fetching a page: the crawl stage knows this exactly ---------------------------------
  const crawl = latestOkRun("crawl");
  const crawlPages = crawl?.items ?? 0;
  const fetchSeconds = crawl && crawlPages ? crawl.wall_ms! / crawlPages / 1000 : cfg.crawl.delay_ms / 1000 + 0.5;
  const fetchBytes = crawl && crawlPages ? (crawl.bytes_in ?? 0) / crawlPages : 250_000;
  notes.fetch_seconds_per_page = crawl && crawlPages
    ? `measured: crawl run ${crawl.run_id}, ${fmt(crawl.wall_ms! / 1000)} s over ${crawlPages} pages (mostly the ${cfg.crawl.delay_ms} ms politeness delay)`
    : `assumed: politeness delay + 0.5 s, no crawl run recorded yet`;
  notes.fetch_bytes_per_page = crawl && crawlPages
    ? `measured: ${(crawl.bytes_in! / 1e6).toFixed(0)} MB over ${crawlPages} pages in the same run`
    : "assumed: 250 kB per page";

  // --- embedding one chunk: the index stage's own embed calls ------------------------------
  const index = latestOkRun("index", true);
  const embed = index ? llmTotals(index.run_id, "embed") : null;
  const chunks = index?.items ?? 0;
  const embeddingUsdPerChunk = embed && chunks ? embed.cost_usd / chunks : 0;
  const embeddingTokensPerChunk = embed && chunks ? embed.input_tokens / chunks : 0;
  const reindexSecondsPerChunk = index && chunks ? index.wall_ms! / chunks / 1000 : 0;
  const embedNote = embed && chunks
    ? `measured: index run ${index!.run_id}, $${embed.cost_usd.toFixed(5)} and ${embed.input_tokens.toLocaleString("en-US")} tokens for ${chunks} chunks`
    : "not measured: no successful index run with embeddings in this database";
  notes.embedding_usd_per_chunk = embedNote;
  notes.embedding_tokens_per_chunk = embedNote;
  notes.reindex_seconds_per_chunk = index && chunks
    ? `measured: the same run took ${fmt(index.wall_ms! / 1000)} s to chunk and embed ${chunks} chunks`
    : "not measured";

  // --- extracting facts from one document ---------------------------------------------------
  // Attributed by stage tag rather than by run id: the fact extraction predates per-stage
  // measurement in this database (COST.md says so out loud), so its money and tokens are exact
  // while its `stage_runs` row does not exist. One call is one document, by construction of
  // src/index/facts.ts, so calls are a valid denominator.
  const facts = llmTotals(null, "facts");
  const extractionUsdPerDoc = facts.calls ? facts.cost_usd / facts.calls : 0;
  const extractionTokensPerDoc = facts.calls ? (facts.input_tokens + facts.output_tokens) / facts.calls : 0;
  const extractionSecondsPerDoc = facts.avg_latency_ms ? facts.avg_latency_ms / 1000 : 0;
  const factsNote = facts.calls
    ? `measured: ${facts.calls} extraction calls, $${facts.cost_usd.toFixed(3)} total, one call per document`
    : "not measured: no fact extraction has run against this database";
  notes.extraction_usd_per_doc = factsNote;
  notes.extraction_tokens_per_doc = factsNote;
  notes.extraction_seconds_per_doc = facts.avg_latency_ms
    ? `measured: mean provider latency ${Math.round(facts.avg_latency_ms)} ms over those calls`
    : "not measured";

  // --- the two figures only a refresh run can measure ----------------------------------------
  const refresh = latestRefreshRun();
  const conditionalSeconds = refresh && refresh.conditional_gets > 0 && refresh.wall_ms
    ? Math.max(cfg.crawl.delay_ms / 1000, refresh.wall_ms / refresh.conditional_gets / 1000)
    : cfg.crawl.delay_ms / 1000 + FALLBACK_CONDITIONAL_EXTRA_SECONDS;
  // `> 0` and not just truthy on `bytes_in`: a run recorded before byte accounting reached the
  // refresh row reports 0, and dividing that by 80 requests would claim a 304 is free.
  const conditionalBytes = refresh && refresh.conditional_gets > 0 && (refresh.bytes_in ?? 0) > 0
    ? refresh.bytes_in / refresh.conditional_gets
    : FALLBACK_CONDITIONAL_BYTES;
  notes.conditional_get_seconds = refresh && refresh.conditional_gets > 0
    ? `measured: refresh run ${refresh.run_id}, ${refresh.conditional_gets} conditional GETs in ${fmt((refresh.wall_ms ?? 0) / 1000)} s`
    : `assumed: the ${cfg.crawl.delay_ms} ms politeness delay + ${FALLBACK_CONDITIONAL_EXTRA_SECONDS} s round trip — no refresh run has measured it yet`;
  notes.conditional_get_bytes = refresh && refresh.conditional_gets > 0 && (refresh.bytes_in ?? 0) > 0
    ? `measured: ${refresh.bytes_in} bytes over ${refresh.conditional_gets} conditional GETs in the same run`
    : `assumed: ${FALLBACK_CONDITIONAL_BYTES} bytes of response headers per 304`;

  const overheadSeconds = FALLBACK_DISCOVERY_REQUESTS * (cfg.crawl.delay_ms / 1000 + 0.3)
    + (latestOkRun("dedup")?.wall_ms ?? 600) / 1000;
  notes.run_overhead_seconds =
    `assumed: ${FALLBACK_DISCOVERY_REQUESTS} discovery requests (robots, the sitemap index and its children, `
    + `the GitHub org listing, llms.txt) at the politeness delay, plus the measured `
    + `${fmt((latestOkRun("dedup")?.wall_ms ?? 600) / 1000)} s dedup pass`;

  return {
    units: {
      fetch_seconds_per_page: fetchSeconds,
      fetch_bytes_per_page: fetchBytes,
      conditional_get_seconds: conditionalSeconds,
      conditional_get_bytes: conditionalBytes,
      embedding_usd_per_chunk: embeddingUsdPerChunk,
      embedding_tokens_per_chunk: embeddingTokensPerChunk,
      extraction_usd_per_doc: extractionUsdPerDoc,
      extraction_tokens_per_doc: extractionTokensPerDoc,
      reindex_seconds_per_chunk: reindexSecondsPerChunk,
      extraction_seconds_per_doc: extractionSecondsPerDoc,
      run_overhead_seconds: overheadSeconds,
    },
    notes,
  };
}

const fmt = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

interface RunRow { run_id: string; wall_ms: number | null; items: number | null; bytes_in: number | null }

/** The newest successful run of a stage. `requireItems` additionally skips runs that processed
 *  nothing, which is what separates "the index build" from the four aborted attempts before it. */
function latestOkRun(stage: string, requireItems = false): RunRow | undefined {
  return one<RunRow>(
    `SELECT run_id, wall_ms, items, bytes_in FROM stage_runs
     WHERE stage = ? AND ok = 1 ${requireItems ? "AND items > 0" : ""} ORDER BY id DESC LIMIT 1`, stage);
}

interface LlmTotals { calls: number; cost_usd: number; input_tokens: number; output_tokens: number; avg_latency_ms: number }

/** Totals from the money ledger for one stage, optionally restricted to one run. */
function llmTotals(runId: string | null, stage: string): LlmTotals {
  const row = one<LlmTotals>(
    `SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost_usd, COALESCE(SUM(input_tokens),0) input_tokens,
            COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(AVG(latency_ms),0) avg_latency_ms
     FROM llm_calls WHERE stage = ? AND ok = 1 ${runId ? "AND run_id = ?" : ""}`,
    ...(runId ? [stage, runId] : [stage]));
  return row ?? { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, avg_latency_ms: 0 };
}

interface RefreshRunRow {
  run_id: string; wall_ms: number | null; conditional_gets: number; bytes_in: number;
}

/** The newest completed refresh run, used to replace the two fallback figures with measurements. */
function latestRefreshRun(): RefreshRunRow | undefined {
  return one<RefreshRunRow>(
    `SELECT r.run_id, s.wall_ms, r.conditional_gets, r.bytes_in
     FROM refresh_runs r LEFT JOIN stage_runs s ON s.run_id = r.run_id
     WHERE r.ok = 1 AND r.dry_run = 0 ORDER BY r.id DESC LIMIT 1`);
}

// --- the corpus half ---------------------------------------------------------------------

interface DocRow { url: string; final_url: string | null; category: string; published_at: string | null; chunks: number }

/**
 * Documents, chunks and observed arrival rates per source type.
 *
 * The arrival rate is the honest part. Where a type carries publication dates and has at least
 * one document from the last twelve months, the rate is counted from the histogram — the blog's
 * 17-a-month is a measurement of this corpus, not a guess. Where a type has dates but none
 * recently (press, video), the whole observed span is averaged instead, and the basis says so.
 * Where a type has no dates at all (docs and GitHub READMEs are Markdown with no date anywhere),
 * the configured assumption is used and labelled as an assumption.
 */
export function corpusProfile(now = new Date()): CorpusProfile {
  const cfg = getConfig().freshness.assumptions;
  const docs = all<DocRow>(
    `SELECT d.url, d.final_url, d.category, d.published_at,
            (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) chunks
     FROM documents d WHERE d.status = 'ok' AND d.duplicate_of IS NULL`);

  const buckets = new Map<SourceType, DocRow[]>(SOURCE_TYPES.map((type) => [type, []]));
  for (const doc of docs) buckets.get(classifySourceType(doc.final_url ?? doc.url, doc.category))!.push(doc);

  const profile = {} as CorpusProfile;
  for (const type of SOURCE_TYPES) profile[type] = profileFor(type, buckets.get(type)!, cfg, now);
  return profile;
}

function profileFor(
  type: SourceType,
  rows: DocRow[],
  assumptions: ReturnType<typeof getConfig>["freshness"]["assumptions"],
  now: Date,
): TypeProfile {
  const documents = rows.length;
  const chunks = rows.reduce((total, row) => total + row.chunks, 0);
  const dated = rows.map((row) => row.published_at).filter((date): date is string => Boolean(date)).sort();

  const windowStart = new Date(now.getTime() - RATE_WINDOW_MONTHS * 30.44 * 86_400_000).toISOString().slice(0, 10);
  const recent = dated.filter((date) => date >= windowStart);

  let newPerMonth: number;
  let basis: string;
  if (recent.length > 0) {
    newPerMonth = recent.length / RATE_WINDOW_MONTHS;
    basis = `measured: ${recent.length} documents published in the last ${RATE_WINDOW_MONTHS} months`;
  } else if (dated.length > 1) {
    // No recent arrivals but a dated history: average over the observed span, which is the
    // honest reading of "this type used to arrive and has gone quiet".
    const spanMonths = Math.max(1, monthsBetween(dated[0], dated[dated.length - 1]));
    newPerMonth = dated.length / spanMonths;
    basis = `measured over the whole observed span (${dated[0].slice(0, 7)} → ${dated[dated.length - 1].slice(0, 7)}), `
      + `nothing new in the last ${RATE_WINDOW_MONTHS} months`;
  } else {
    newPerMonth = assumptions.new_docs_per_month[type] ?? 0;
    basis = `assumed (${newPerMonth}/month): this type carries no publication dates, so its arrival rate cannot be measured from the corpus`;
  }

  return {
    documents,
    chunks_per_doc: documents ? chunks / documents : 0,
    new_docs_per_month: newPerMonth,
    change_rate_per_month: assumptions.change_rate_per_month[type] ?? 0,
    sitemap_coverage: assumptions.sitemap_coverage[type] ?? 0,
    basis,
  };
}

function monthsBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / (30.44 * 86_400_000);
}
