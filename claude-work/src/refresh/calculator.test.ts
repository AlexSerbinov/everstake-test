// The calculator's arithmetic, pinned. Nothing here touches the database: `estimateFreshness`
// is a pure function, and these tests are the reason it is one — the numbers on the Freshness
// view are the ones an operator makes a spending decision on, so they have to be checkable
// without a crawl, a key or a network.
//
// The unit costs below are deliberately round rather than the real measured ones: a test that
// hardcodes $0.000010367 per chunk breaks every time the index is rebuilt and proves nothing
// about the formula. The real values are read by `units.ts` and shown in the UI with their
// provenance; what has to stay true here is the arithmetic that combines them.

import assert from "node:assert/strict";
import test from "node:test";
import { estimateFreshness, formatStaleness, type CorpusProfile, type UnitCosts } from "./calculator.js";
import { SOURCE_TYPES, runsPerMonth, worstCaseStalenessHours, type FreshnessPolicy } from "./policy.js";

const UNITS: UnitCosts = {
  fetch_seconds_per_page: 0.5,
  fetch_bytes_per_page: 200_000,
  conditional_get_seconds: 0.75,
  conditional_get_bytes: 700,
  embedding_usd_per_chunk: 0.00001,
  embedding_tokens_per_chunk: 500,
  extraction_usd_per_doc: 0.005,
  extraction_tokens_per_doc: 3000,
  reindex_seconds_per_chunk: 0.02,
  extraction_seconds_per_doc: 2,
  run_overhead_seconds: 10,
};

/** Every type empty except the ones a test fills in, so a test's numbers come from one type. */
function corpus(overrides: Partial<Record<string, Partial<CorpusProfile[keyof CorpusProfile]>>> = {}): CorpusProfile {
  const empty = {
    documents: 0, chunks_per_doc: 0, new_docs_per_month: 0, change_rate_per_month: 0,
    sitemap_coverage: 0, basis: "test",
  };
  const profile = {} as CorpusProfile;
  for (const type of SOURCE_TYPES) profile[type] = { ...empty, ...(overrides[type] ?? {}) };
  return profile;
}

/** Every type `never` except the ones a test names. */
function policy(overrides: Partial<FreshnessPolicy> = {}): FreshnessPolicy {
  const out = {} as FreshnessPolicy;
  for (const type of SOURCE_TYPES) out[type] = { interval: "never", depth: "check" };
  return { ...out, ...overrides };
}

test("runs per month comes from a 730-hour month, and `never` is exactly zero", () => {
  assert.equal(runsPerMonth("hourly"), 730);
  assert.equal(runsPerMonth("daily"), 730 / 24);
  assert.equal(runsPerMonth("weekly"), 730 / 168);
  assert.equal(runsPerMonth("monthly"), 1);
  assert.equal(runsPerMonth("never"), 0);
});

test("worst-case staleness is the whole interval, not half of it", () => {
  assert.equal(worstCaseStalenessHours("daily"), 24);
  assert.equal(worstCaseStalenessHours("never"), Infinity);
  assert.equal(formatStaleness(24), "24 hours");
  assert.equal(formatStaleness(168), "7 days");
  assert.equal(formatStaleness(1), "1 hour");
  assert.equal(formatStaleness(Infinity), "unbounded");
});

test("`never` costs nothing at all — no requests, no money, no minutes", () => {
  const estimate = estimateFreshness({
    policy: policy({ blog: { interval: "never", depth: "refacts" } }),
    units: UNITS,
    corpus: corpus({ blog: { documents: 250, chunks_per_doc: 5, change_rate_per_month: 0.5, new_docs_per_month: 17 } }),
  });
  const blog = estimate.per_type.find((row) => row.type === "blog")!;
  assert.equal(blog.usd_per_month, 0);
  assert.equal(blog.checks_per_month, 0);
  assert.equal(blog.machine_minutes_per_month, 0);
  assert.equal(blog.worst_case_staleness_hours, Infinity);
  assert.deepEqual(estimate.total.types_never_checked, [...SOURCE_TYPES]);
});

test("depth `check` costs nothing for an edit, but a NEW document is still indexed in full", () => {
  const shared = {
    units: UNITS,
    corpus: corpus({ blog: { documents: 100, chunks_per_doc: 4, change_rate_per_month: 0.1, new_docs_per_month: 2 } }),
  };
  const checkOnly = estimateFreshness({ ...shared, policy: policy({ blog: { interval: "weekly", depth: "check" } }) });
  const blog = checkOnly.per_type.find((row) => row.type === "blog")!;

  // 10 changed documents cost nothing at `check`; the 2 new ones are embedded (4 chunks each)
  // and fact-extracted: 2 × 4 × $0.00001 + 2 × $0.005 = $0.00008 + $0.01.
  assert.equal(blog.reindexed_docs_per_month, 0);
  assert.equal(blog.refacted_docs_per_month, 0);
  assert.equal(blog.embedding_usd, 0.00008);
  assert.equal(blog.extraction_usd, 0.01);
  assert.equal(blog.usd_per_month, 0.01008);
});

test("depth ladder: reindex adds embeddings for changed docs, refacts adds extraction on top", () => {
  const shared = {
    units: UNITS,
    corpus: corpus({ blog: { documents: 100, chunks_per_doc: 4, change_rate_per_month: 0.1, new_docs_per_month: 0 } }),
  };
  const reindex = estimateFreshness({ ...shared, policy: policy({ blog: { interval: "weekly", depth: "reindex" } }) })
    .per_type.find((row) => row.type === "blog")!;
  const refacts = estimateFreshness({ ...shared, policy: policy({ blog: { interval: "weekly", depth: "refacts" } }) })
    .per_type.find((row) => row.type === "blog")!;

  // 10 changed docs × 4 chunks × $0.00001 = $0.0004, no extraction.
  assert.equal(reindex.embedding_usd, 0.0004);
  assert.equal(reindex.extraction_usd, 0);
  // refacts keeps the embeddings and adds 10 × $0.005.
  assert.equal(refacts.embedding_usd, 0.0004);
  assert.equal(refacts.extraction_usd, 0.05);
  assert.ok(refacts.usd_per_month > reindex.usd_per_month);
});

test("a change is only found once per check, so a slower interval is genuinely cheaper", () => {
  // 20 documents rewritten twice a month (change rate 2.0) but checked monthly: at most 20
  // changes can be observed, not 40.
  const monthly = estimateFreshness({
    policy: policy({ docs: { interval: "monthly", depth: "reindex" } }),
    units: UNITS,
    corpus: corpus({ docs: { documents: 20, chunks_per_doc: 2, change_rate_per_month: 2.0 } }),
  }).per_type.find((row) => row.type === "docs")!;
  assert.equal(monthly.changed_docs_per_month, 20);

  const weekly = estimateFreshness({
    policy: policy({ docs: { interval: "weekly", depth: "reindex" } }),
    units: UNITS,
    corpus: corpus({ docs: { documents: 20, chunks_per_doc: 2, change_rate_per_month: 2.0 } }),
  }).per_type.find((row) => row.type === "docs")!;
  // Weekly can see all 40 edits (20 docs × 4.35 checks a month is well above 40).
  assert.equal(weekly.changed_docs_per_month, 40);
  assert.ok(weekly.usd_per_month > monthly.usd_per_month);
});

test("sitemap coverage removes a request per document per check", () => {
  const withSitemap = estimateFreshness({
    policy: policy({ blog: { interval: "daily", depth: "check" } }),
    units: UNITS,
    corpus: corpus({ blog: { documents: 100, sitemap_coverage: 1 } }),
  }).per_type.find((row) => row.type === "blog")!;
  const withoutSitemap = estimateFreshness({
    policy: policy({ blog: { interval: "daily", depth: "check" } }),
    units: UNITS,
    corpus: corpus({ blog: { documents: 100, sitemap_coverage: 0 } }),
  }).per_type.find((row) => row.type === "blog")!;

  // Fully covered and nothing changing: the sitemap settles every document, zero HTTP requests.
  assert.equal(withSitemap.conditional_gets_per_month, 0);
  // Uncovered: one conditional GET per document per check — 100 × 730/24 ≈ 3042.
  assert.equal(withoutSitemap.conditional_gets_per_month, Math.round(100 * (730 / 24)));
  assert.ok(withoutSitemap.machine_minutes_per_month > withSitemap.machine_minutes_per_month);
});

test("machine minutes account for the per-run overhead even when nothing is due", () => {
  const estimate = estimateFreshness({
    policy: policy({ live_pages: { interval: "daily", depth: "check" } }),
    units: UNITS,
    corpus: corpus({ live_pages: { documents: 1, sitemap_coverage: 1 } }),
  });
  const live = estimate.per_type.find((row) => row.type === "live_pages")!;
  // 730/24 runs × 10 s of overhead ≈ 5.07 minutes; nothing else happens.
  assert.equal(live.machine_minutes_per_month, Math.round((730 / 24) * 10 / 60 * 10) / 10);
});

test("totals sum the types, and the headline staleness ignores the ones set to `never`", () => {
  const estimate = estimateFreshness({
    policy: policy({
      live_pages: { interval: "hourly", depth: "refacts" },
      blog: { interval: "weekly", depth: "reindex" },
      video: { interval: "never", depth: "check" },
    }),
    units: UNITS,
    corpus: corpus({
      live_pages: { documents: 30, chunks_per_doc: 3, change_rate_per_month: 0.1, sitemap_coverage: 1 },
      blog: { documents: 200, chunks_per_doc: 4, change_rate_per_month: 0.01, sitemap_coverage: 1, new_docs_per_month: 17 },
      video: { documents: 12, chunks_per_doc: 8, change_rate_per_month: 1 },
    }),
  });

  const sum = estimate.per_type.reduce((total, row) => total + row.usd_per_month, 0);
  assert.ok(Math.abs(estimate.total.usd_per_month - sum) < 1e-9);
  // The slowest *checked* type is the weekly blog, so nothing can be more than a week stale.
  assert.equal(estimate.total.worst_case_staleness_hours, 168);
  assert.deepEqual(estimate.total.types_never_checked, SOURCE_TYPES.filter((type) => type === "video" || (type !== "live_pages" && type !== "blog")));
});

test("the plain sentence names the interval, the money and the staleness", () => {
  const estimate = estimateFreshness({
    policy: policy({ blog: { interval: "daily", depth: "refacts" } }),
    units: UNITS,
    corpus: corpus({ blog: { documents: 250, chunks_per_doc: 4, change_rate_per_month: 0.01, sitemap_coverage: 1, new_docs_per_month: 17 } }),
  });
  const blog = estimate.per_type.find((row) => row.type === "blog")!;
  assert.match(blog.plain, /Checking the blog once a day costs about \$\d/);
  assert.match(blog.plain, /within 24 hours/);
  assert.match(estimate.plain, /a month and \d+ minutes of machine time/);
  assert.match(estimate.plain, /Nothing we watch can be more than 24 hours out of date|slowest thing we watch/);
});

test("an empty type costs nothing and says so, whatever the interval", () => {
  const estimate = estimateFreshness({
    policy: policy({ press: { interval: "hourly", depth: "refacts" } }),
    units: UNITS,
    corpus: corpus(),
  });
  const press = estimate.per_type.find((row) => row.type === "press")!;
  assert.equal(press.usd_per_month, 0);
  assert.match(press.plain, /No press coverage documents are in the corpus|never re-checked/);
});
