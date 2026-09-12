// What a freshness policy costs per month, computed from measured unit costs.
//
// This module is a pure function and nothing else: no database, no clock, no config lookup. It
// takes (policy, unit costs, corpus profile) and returns money, tokens, machine minutes and
// worst-case staleness, per source type and in total. `units.ts` is what reads the measurements
// out of `stage_runs` and `llm_calls` and builds the inputs; the API and the UI slider both call
// this with whatever policy is on screen.
//
// It is pure because it is the one part of the freshness feature a reviewer will want to argue
// with, and an argument about arithmetic should be settleable by reading twenty lines and a test
// rather than by running a crawl. `calculator.test.ts` pins every branch.
//
// THE MODEL, stated once so the numbers are readable:
//
//   runs/month            = 730 h ÷ the interval, 0 for `never`
//   documents             = what the corpus actually holds for this type, counted
//   change rate           = fraction of EXISTING documents edited per month (assumption, config)
//   new documents/month   = measured from the corpus's own published_at histogram where dates
//                           exist, assumed from config where they do not (docs, GitHub)
//
//   checks/month          = documents × runs
//   HTTP requests/month   = documents not covered by a sitemap × runs        (one conditional GET each)
//                         + documents whose lastmod moved                    (a real body)
//                         + new documents                                    (a real body)
//   money/month           = new documents      × (embed + extract)           — always, at every depth
//                         + changed documents  × embed                        if depth ≥ reindex
//                         + changed documents  × extract                      if depth = refacts
//   machine minutes       = runs × per-run overhead
//                         + conditional GETs × the cheap per-request second
//                         + body fetches     × the measured per-page second
//                         + re-indexed chunks and re-extracted documents × their measured seconds
//   worst-case staleness  = the interval itself, not half of it
//
// Two modelling choices worth defending:
//
//  · A NEW document is indexed and fact-extracted regardless of depth. "Cheap check only" is a
//    statement about how much work an *edit* deserves; a page that is not in the index at all is
//    not stale, it is absent, and no interesting policy chooses to leave it out.
//  · Changes are capped at one per document per run. A blog post edited three times between two
//    weekly checks is re-indexed once, so raising the interval never raises the bill — which is
//    exactly the property that makes the economy preset cheap rather than merely slower.

import {
  HOURS_PER_MONTH,
  SOURCE_TYPES,
  depthAtLeast,
  runsPerMonth,
  worstCaseStalenessHours,
  type FreshnessPolicy,
  type SourceType,
} from "./policy.js";

/** Measured per-unit costs. Every field is a measurement or is explicitly labelled otherwise by
 *  `units.ts`, which is the only thing that builds this object outside tests. */
export interface UnitCosts {
  /** Seconds of wall time per full page fetch, measured from the crawl stage (mostly politeness delay). */
  fetch_seconds_per_page: number;
  /** Bytes per full page fetch, measured from the crawl stage. */
  fetch_bytes_per_page: number;
  /** Seconds per conditional GET that comes back 304 — no body, no parsing, no politeness cost
   *  beyond the same crawl delay. Measured from a refresh run once one exists. */
  conditional_get_seconds: number;
  /** Bytes per 304 response: response headers only. */
  conditional_get_bytes: number;
  /** USD to embed one chunk, measured from the index stage's embed calls ÷ its chunks. */
  embedding_usd_per_chunk: number;
  /** Embedding input tokens per chunk, same source. */
  embedding_tokens_per_chunk: number;
  /** USD for one fact-extraction call, measured from the facts stage ÷ its documents. */
  extraction_usd_per_doc: number;
  /** Extraction tokens (input + output) per document, same source. */
  extraction_tokens_per_doc: number;
  /** Seconds to chunk + embed one chunk, measured from the index stage's wall time. */
  reindex_seconds_per_chunk: number;
  /** Seconds for one extraction call. */
  extraction_seconds_per_doc: number;
  /** Fixed seconds per refresh run, whatever it finds: process start, sitemap and robots fetches,
   *  the GitHub org listing, the dedup pass at the end. */
  run_overhead_seconds: number;
}

/** What the corpus looks like for one source type. Counted, not assumed, except where noted. */
export interface TypeProfile {
  /** Canonical documents of this type in the index right now. Counted. */
  documents: number;
  /** Mean chunks per document of this type. Counted. */
  chunks_per_doc: number;
  /** New documents appearing per month. Measured from published_at where the type has dates. */
  new_docs_per_month: number;
  /** Fraction of existing documents edited per month. Assumption, from config. */
  change_rate_per_month: number;
  /** Fraction settled by the sitemap / org-listing sieve with no request of their own. */
  sitemap_coverage: number;
  /** One sentence saying where `new_docs_per_month` came from. Printed in the UI footnote. */
  basis: string;
}

export type CorpusProfile = Record<SourceType, TypeProfile>;

export interface EstimateInput {
  policy: FreshnessPolicy;
  units: UnitCosts;
  corpus: CorpusProfile;
}

/** What one source type costs under the policy. Every field is per month unless named otherwise. */
export interface TypeEstimate {
  type: SourceType;
  interval: string;
  depth: string;
  documents: number;
  runs_per_month: number;
  checks_per_month: number;
  conditional_gets_per_month: number;
  body_fetches_per_month: number;
  changed_docs_per_month: number;
  new_docs_per_month: number;
  reindexed_docs_per_month: number;
  refacted_docs_per_month: number;
  embedding_usd: number;
  extraction_usd: number;
  usd_per_month: number;
  tokens_per_month: number;
  machine_minutes_per_month: number;
  bytes_per_month: number;
  /** Longest a change can go unnoticed. `Infinity` for `never`. */
  worst_case_staleness_hours: number;
  /** The sentence the UI prints under the row. */
  plain: string;
}

export interface FreshnessEstimate {
  per_type: TypeEstimate[];
  total: {
    usd_per_month: number;
    tokens_per_month: number;
    machine_minutes_per_month: number;
    bytes_per_month: number;
    checks_per_month: number;
    body_fetches_per_month: number;
    /** The worst staleness across every type that is checked at all — the number an operator
     *  can promise. Types set to `never` are excluded and reported separately. */
    worst_case_staleness_hours: number;
    types_never_checked: SourceType[];
  };
  /** One sentence for the headline card. */
  plain: string;
}

/** Round money to the cent-fraction the rest of the reports use, without printing 1e-9. */
const money = (usd: number) => Math.round(usd * 1e6) / 1e6;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Price one policy. Pure: the same inputs always give the same object, which is what lets the
 * UI call it on every slider drag and the test call it with literals.
 */
export function estimateFreshness(input: EstimateInput): FreshnessEstimate {
  const perType = SOURCE_TYPES.map((type) => estimateType(type, input));

  const sum = (pick: (row: TypeEstimate) => number) => perType.reduce((total, row) => total + pick(row), 0);
  const checkedTypes = perType.filter((row) => row.runs_per_month > 0);
  const neverChecked = perType.filter((row) => row.runs_per_month === 0).map((row) => row.type);

  const total = {
    usd_per_month: money(sum((row) => row.usd_per_month)),
    tokens_per_month: Math.round(sum((row) => row.tokens_per_month)),
    machine_minutes_per_month: round1(sum((row) => row.machine_minutes_per_month)),
    bytes_per_month: Math.round(sum((row) => row.bytes_per_month)),
    checks_per_month: Math.round(sum((row) => row.checks_per_month)),
    body_fetches_per_month: round1(sum((row) => row.body_fetches_per_month)),
    worst_case_staleness_hours: checkedTypes.length
      ? Math.max(...checkedTypes.map((row) => row.worst_case_staleness_hours))
      : Infinity,
    types_never_checked: neverChecked,
  };

  // The headline promise is set by the single slowest type, and on every preset here that type
  // is video — a transcript that is never rewritten. Quoting "a month" alone would make a policy
  // that checks everything else daily sound sluggish, so the sentence names the laggard and the
  // bound on everything else. Both numbers, not one.
  const slowest = checkedTypes.length
    ? checkedTypes.reduce((worst, row) => (row.worst_case_staleness_hours > worst.worst_case_staleness_hours ? row : worst))
    : null;
  const rest = checkedTypes.filter((row) => row !== slowest);
  return {
    per_type: perType,
    total,
    plain: headlineSentence(total, slowest?.type ?? null,
      rest.length ? Math.max(...rest.map((row) => row.worst_case_staleness_hours)) : null),
  };
}

function estimateType(type: SourceType, { policy, units, corpus }: EstimateInput): TypeEstimate {
  const { interval, depth } = policy[type];
  const profile = corpus[type];
  const runs = runsPerMonth(interval);
  const staleness = worstCaseStalenessHours(interval);

  // `never` is a complete stop: no requests, no money, no minutes. Not "very rarely" — the
  // scheduler genuinely never selects the type, and the estimate has to say so rather than
  // print a tiny number that invites rounding it to zero anyway.
  if (runs === 0 || profile.documents === 0) {
    return {
      type, interval, depth,
      documents: profile.documents,
      runs_per_month: runs,
      checks_per_month: 0, conditional_gets_per_month: 0, body_fetches_per_month: 0,
      changed_docs_per_month: 0, new_docs_per_month: 0,
      reindexed_docs_per_month: 0, refacted_docs_per_month: 0,
      embedding_usd: 0, extraction_usd: 0, usd_per_month: 0,
      tokens_per_month: 0, machine_minutes_per_month: 0, bytes_per_month: 0,
      worst_case_staleness_hours: staleness,
      plain: plainSentence(type, interval, depth, 0, profile, staleness, runs),
    };
  }

  const checks = profile.documents * runs;
  // A document can only be found changed once per check, so a type edited more often than it is
  // checked is bounded by the check rate — this is why a slower interval is genuinely cheaper
  // rather than merely later.
  const changed = Math.min(profile.documents * profile.change_rate_per_month, profile.documents * runs);
  const added = profile.new_docs_per_month;

  // Sieve 1 covers a share of the type with no per-document request at all. The rest pays one
  // conditional GET per check; the covered ones only pay a request when their lastmod moved.
  const uncovered = profile.documents * (1 - profile.sitemap_coverage);
  const conditionalGets = uncovered * runs + changed * profile.sitemap_coverage;
  // A body crosses the wire only for a document that actually changed, plus every new one.
  const bodyFetches = changed + added;

  // Depth decides what an EDIT is worth. A new document is always indexed in full — see the
  // header note.
  const reindexed = depthAtLeast(depth, "reindex") ? changed : 0;
  const refacted = depthAtLeast(depth, "refacts") ? changed : 0;

  const embeddedDocs = reindexed + added;
  const extractedDocs = refacted + added;

  const embeddingUsd = embeddedDocs * profile.chunks_per_doc * units.embedding_usd_per_chunk;
  const extractionUsd = extractedDocs * units.extraction_usd_per_doc;
  const usd = embeddingUsd + extractionUsd;

  const tokens =
    embeddedDocs * profile.chunks_per_doc * units.embedding_tokens_per_chunk +
    extractedDocs * units.extraction_tokens_per_doc;

  const seconds =
    runs * units.run_overhead_seconds +
    conditionalGets * units.conditional_get_seconds +
    bodyFetches * units.fetch_seconds_per_page +
    embeddedDocs * profile.chunks_per_doc * units.reindex_seconds_per_chunk +
    extractedDocs * units.extraction_seconds_per_doc;

  const bytes = conditionalGets * units.conditional_get_bytes + bodyFetches * units.fetch_bytes_per_page;

  return {
    type, interval, depth,
    documents: profile.documents,
    runs_per_month: round1(runs),
    checks_per_month: Math.round(checks),
    conditional_gets_per_month: Math.round(conditionalGets),
    body_fetches_per_month: round1(bodyFetches),
    changed_docs_per_month: round1(changed),
    new_docs_per_month: round1(added),
    reindexed_docs_per_month: round1(reindexed),
    refacted_docs_per_month: round1(refacted),
    embedding_usd: money(embeddingUsd),
    extraction_usd: money(extractionUsd),
    usd_per_month: money(usd),
    tokens_per_month: Math.round(tokens),
    machine_minutes_per_month: round1(seconds / 60),
    bytes_per_month: Math.round(bytes),
    worst_case_staleness_hours: staleness,
    plain: plainSentence(type, interval, depth, usd, profile, staleness, runs),
  };
}

/** "every hour" reads better than "hourly" inside a sentence, and "within 24 hours" better than
 *  "within 1 day" when the reader is comparing it against "within 1 hour" on the row above. */
const INTERVAL_PHRASE: Record<string, string> = {
  hourly: "every hour",
  daily: "once a day",
  weekly: "once a week",
  monthly: "once a month",
  never: "never",
};

export function formatStaleness(hours: number): string {
  if (!Number.isFinite(hours)) return "unbounded";
  // Hours up to and including a day, because "within 24 hours" is the phrase the operator
  // thinks in and "within 1 day" reads as vaguer than it is next to "within 1 hour".
  if (hours <= 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  if (hours < HOURS_PER_MONTH) return `${Math.round(hours / 24)} days`;
  return "a month";
}

const DEPTH_PHRASE: Record<string, string> = {
  check: "notices the change but leaves the index alone",
  reindex: "re-indexes what changed",
  refacts: "re-indexes what changed and re-reads its facts",
};

/** The plain-language line the assignment asks for, e.g. "Checking the blog once a day costs
 *  about $0.36/month, re-indexes what changed and re-reads its facts, and finds a new post
 *  within 24 hours." */
function plainSentence(
  type: SourceType,
  interval: string,
  depth: string,
  usd: number,
  profile: TypeProfile,
  staleness: number,
  runs: number,
): string {
  const noun = TYPE_NOUN[type];
  if (runs === 0) {
    return `${capitalise(noun)} is never re-checked: it costs nothing, and a change there would never be noticed.`;
  }
  if (profile.documents === 0) {
    return `No ${noun} documents are in the corpus, so this setting costs nothing today.`;
  }
  // "costs about under a cent/month" is what a naive template produces; the two cases are
  // written out because this sentence is the one an operator actually reads.
  const price = usd < 0.01 && usd > 0
    ? "costs less than a cent a month"
    : `costs about ${formatUsdShort(usd)} a month`;
  return `Checking ${noun} ${INTERVAL_PHRASE[interval]} ${price}, `
    + `${DEPTH_PHRASE[depth]}, and finds a change within ${formatStaleness(staleness)}.`;
}

const TYPE_NOUN: Record<SourceType, string> = {
  live_pages: "the live pages",
  blog: "the blog",
  docs: "the docs",
  reports_events: "reports and events",
  github: "GitHub",
  video: "video subtitles",
  press: "press coverage",
};

/** Money in a sentence: never more precision than a reader can act on, never a bare 0. */
export function formatUsdShort(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "under a cent";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

function headlineSentence(
  total: FreshnessEstimate["total"], slowestType: SourceType | null, restHours: number | null,
): string {
  const never = total.types_never_checked.length
    ? ` ${total.types_never_checked.length} source type${total.types_never_checked.length === 1 ? " is" : "s are"} not watched at all.`
    : "";
  if (!slowestType) {
    return `Nothing is being checked, so this policy costs nothing and guarantees nothing.${never}`;
  }
  const worst = formatStaleness(total.worst_case_staleness_hours);
  const tail = restHours !== null && restHours < total.worst_case_staleness_hours
    ? ` The slowest thing we watch is ${TYPE_NOUN[slowestType]} (${worst}); everything else is checked within ${formatStaleness(restHours)}.`
    : ` Nothing we watch can be more than ${worst} out of date.`;
  return `About ${formatUsdShort(total.usd_per_month)} a month and ${Math.round(total.machine_minutes_per_month)} minutes of machine time.${tail}${never}`;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
