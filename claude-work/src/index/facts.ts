// Pipeline: crawl → dedup → index/build → **facts** → retrieve → answer → eval.
//
// The second retrieval path. Chunks answer "what does the corpus say about X" fuzzily; this
// module gives the answerer a structured, date-stamped ledger — `(key, value, as_of, quote,
// source)` — extracted once per canonical document by the cheap model. That is what turns "how
// many networks" from a similarity search into a timeline the model can read directly:
// 70 (2022) → 70+ (2024) → 85 (2025-06) → 130+ (2026). See REPORT §2.2.
//
// Extraction is a model call, so it is done ONCE per document at index time and cached in the
// `facts` table; answering never pays for it. The `as_of` stamp is the load-bearing part — a
// fact without a date cannot be compared against a newer one, and the CEO trap (a 2025 press
// release vs. the company page fetched in 2026) is exactly that comparison.

import { z } from "zod";
import { getConfig } from "../config.js";
import { all, run, transaction } from "../db.js";
import { completeJson, loadPrompt } from "../llm.js";
import { malformedNumbers } from "../crawl/extract.js";

const FactSchema = z.object({
  facts: z.array(z.object({
    key: z.string(),
    value: z.string(),
    as_of: z.string().nullable(),
    quote: z.string(),
    confidence: z.number().min(0).max(1),
    flags: z.array(z.string()).default([]),
  })),
});

// A closed vocabulary, enforced in code rather than trusted from the prompt: the model invents
// plausible keys ("network_count", "ceo_name") and each variant would become an invisible second
// row for the same fact. Anything outside this list is dropped silently.
const ALLOWED = new Set("networks_supported,delegators,total_staked_usd,rewards_generated_usd,uptime,validators,ceo,president,founder,ccdo,founded_year,legal_entity,headquarters,certifications,auditor,products,team_size,mcp_endpoint,slashing_events,partners,custody_model".split(","));

// Categories whose pages describe the present rather than a past event, so an undated one is
// current "as of" the day we fetched it.
const LIVE_PAGE_CATEGORIES = ["site", "docs", "code"];

// The model is asked for YYYY-MM-DD; anything else ("2024", "last quarter", "n/a") is not a date
// we can order against another date, so it is treated as absent.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Documents in flight at once. Small on purpose: this is a background index step, and a burst
// large enough to hit the provider's rate limit would cost more in retries than it saves.
const CONCURRENT_DOCUMENTS = 4;

// The model only needs the top of a page to find its facts, and the tail of a long docs page is
// mostly navigation. Caps the per-document input cost; hand-tuned, no measurement backs 24000.
const MAX_DOC_CHARS = 24000;

// Quotes are evidence shown in the UI, not content — 400 chars is enough to check attribution.
const MAX_QUOTE_CHARS = 400;

interface FactSourceDoc {
  id: number;
  url: string;
  title: string;
  text: string;
  published_at: string | null;
  fetched_at: string;
  category: string;
  n: number;
}

/**
 * Fill the fact ledger for every canonical document that does not have one yet.
 *
 * Incremental by default (a document with rows is skipped) because each document costs a model
 * call; `force` re-extracts, `urlLike` and `limit` exist to iterate on the prompt against a
 * handful of pages without paying for the whole corpus.
 */
export async function extractFacts(opts: { force?: boolean; limit?: number; urlLike?: string; docIds?: number[] }) {
  const cfg = getConfig();
  const docs = all<FactSourceDoc>(
    `SELECT d.id, d.url, d.title, d.text, d.published_at, d.fetched_at, d.category, (SELECT COUNT(*) FROM facts f WHERE f.doc_id = d.id) n
     FROM documents d WHERE d.status='ok' AND d.duplicate_of IS NULL ORDER BY d.tier, d.id`);
  // `docIds` is the refresher's entry point: it knows exactly which documents changed, and
  // re-extracting the whole corpus to pick up three edited pages is the mistake this option
  // exists to make impossible. It implies `force`, since a changed document already has rows.
  const only = opts.docIds ? new Set(opts.docIds) : null;
  const todo = docs
    .filter((doc) => (only ? only.has(doc.id) : opts.force || doc.n === 0))
    .filter((doc) => !opts.urlLike || doc.url.includes(opts.urlLike))
    .slice(0, opts.limit ?? Infinity);

  console.log(`extracting facts from ${todo.length} documents with ${cfg.models.cheap}…`);
  const system = loadPrompt("extract_facts");
  let total = 0, cost = 0;

  // Shared queue rather than a chunked split: documents differ by an order of magnitude in
  // length, so a static split would leave three workers idle behind one long docs page.
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const doc = queue.shift()!;
      try {
        const completion = await completeJson({
          stage: "facts", model: cfg.models.cheap, system, schema: FactSchema, maxTokens: 2000, cacheSystem: true,
          user: buildExtractionPrompt(doc),
          meta: { doc_id: doc.id },
        });
        cost += completion.costUsd;
        total += storeFactsForDocument(doc, completion.data.facts);
        process.stdout.write(`  doc ${doc.id} → ${completion.data.facts.length} facts  (running cost $${cost.toFixed(3)})\r`);
      } catch (error: any) {
        // One document's failure (a schema violation, a provider hiccup) must not abandon the
        // other 458; the missing rows simply get picked up on the next incremental run.
        console.warn(`\n  doc ${doc.id} failed: ${String(error?.message ?? error).slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_DOCUMENTS }, worker));

  const removed = cleanFacts();
  console.log(`\nfacts done: ${total} facts extracted, ${removed} removed by hygiene rules, $${cost.toFixed(4)}`);
  // Returned so the CLI can attach the counts to this run's `stage_runs` row. The cost is also
  // returned, but only as a cross-check: the figure COST.md publishes comes from `llm_calls`,
  // never from this accumulator, so the two can be compared instead of one trusting the other.
  return { documents: todo.length, facts: total, removed, cost_usd: Number(cost.toFixed(5)) };
}

/**
 * The URL, title and publication date are given to the model alongside the text because several
 * facts are only interpretable with them (an undated "we now support 130+ networks" means
 * something different on a 2022 blog post than on the live product page).
 */
function buildExtractionPrompt(doc: FactSourceDoc): string {
  return `Document URL: ${doc.url}\nTitle: ${doc.title}\nPublished: ${doc.published_at ?? "unknown"}\n\n`
    + `<document>\n${doc.text.slice(0, MAX_DOC_CHARS)}\n</document>`;
}

/**
 * Replace this document's rows with the ones the model just returned, in one transaction so a
 * crash cannot leave a document with half a ledger. Returns how many rows were actually kept
 * (the model's count and ours differ whenever it invented a key outside ALLOWED).
 */
function storeFactsForDocument(doc: FactSourceDoc, facts: z.infer<typeof FactSchema>["facts"]): number {
  let stored = 0;
  transaction(() => {
    run("DELETE FROM facts WHERE doc_id = ?", doc.id);
    for (const fact of facts) {
      if (!ALLOWED.has(fact.key)) continue;

      const flags = new Set(fact.flags);
      // The crawled corpus contains genuinely corrupted numerals ("735,,,," in a meta
      // description). Flagged rather than dropped: the UI shows the flag, and a human decides.
      if (malformedNumbers(fact.value).length || malformedNumbers(fact.quote).length) flags.add("malformed_number");

      const { asOf, asOfSource } = resolveFactAsOf(fact.as_of, doc);
      run("INSERT INTO facts (doc_id, key, value, as_of, as_of_source, quote, confidence, flags) VALUES (?,?,?,?,?,?,?,?)",
        doc.id, fact.key, fact.value.trim(), asOf, asOfSource, fact.quote.slice(0, MAX_QUOTE_CHARS), fact.confidence,
        flags.size ? [...flags].join(",") : null);
      stored++;
    }
  });
  return stored;
}

/**
 * Decide the date a fact is true "as of", and record which of three sources that date came from
 * so the answerer (and the UI) can weigh it. Priority, strongest evidence first:
 *
 *  1. `text`      — the document states the date next to the claim ("as of June 2025, 85 chains").
 *                   Beats everything: it is the only source that dates the CLAIM rather than the page.
 *  2. `document`  — the page's own publication date. An announcement is true as of when it was
 *                   published, even if we crawl it two years later.
 *  3. `live-page` — an undated site/docs/code page describes the present, so it is true as of the
 *                   fetch date. This is what lets a 2026 company page outrank a 2025 press release
 *                   about the same role instead of losing to it for having "no date".
 *  4. `null`      — an undated page that is neither of the above (a news article we could not
 *                   date). Undated facts do not win comparisons; better than inventing a date.
 *
 * Exported and pure so each branch can be pinned in facts.test.ts — it used to live inside the
 * concurrent worker loop, where it was the one untested decision in the module.
 */
export function resolveFactAsOf(
  factAsOf: string | null,
  doc: { published_at: string | null; fetched_at: string; category: string },
): { asOf: string | null; asOfSource: "text" | "document" | "live-page" | null } {
  if (factAsOf && ISO_DATE.test(factAsOf)) return { asOf: factAsOf, asOfSource: "text" };
  if (doc.published_at) return { asOf: doc.published_at, asOfSource: "document" };
  // `fetched_at` is a full ISO timestamp; the ledger compares days, not instants.
  if (LIVE_PAGE_CATEGORIES.includes(doc.category)) return { asOf: doc.fetched_at.slice(0, 10), asOfSource: "live-page" };
  return { asOf: null, asOfSource: null };
}

const PERSON_KEYS = ["ceo", "president", "founder", "ccdo"];
const NUMERIC_KEYS = ["networks_supported", "delegators", "total_staked_usd", "rewards_generated_usd", "uptime", "validators", "team_size", "founded_year"];

/**
 * Cheap, deterministic hygiene after the model, and the last thing standing between "a blog post
 * quoted some other company's CEO" and "Everstake's CEO is <that person>". Deliberately SQL and
 * not a second model call: it is free, it is auditable, and it can be re-applied after a rule
 * change without paying to extract the corpus again. Returns rows removed.
 */
export function cleanFacts(): number {
  return dropLeadershipFactsAboutOtherCompanies() + dropNumericFactsWithoutADigit();
}

/** `?,?,?` placeholder list for an IN clause of `keys.length` bound parameters. */
const placeholders = (keys: string[]) => keys.map(() => "?").join(",");

/**
 * A leadership fact must be about Everstake. Third-party pages, Everstake's own blog and video
 * transcripts are full of other companies' executives ("Jane Roe, CEO of Acme Labs, commented"),
 * and one such row silently becomes the answer to "who is the CEO". On Everstake's own non-blog
 * pages (about, careers, press) a bare "Sergii Vasylchuk — CEO" needs no company name, so those
 * are exempt.
 *
 * KNOWN LIMITATION: the test is only whether the word "everstake" occurs anywhere in the quote,
 * not whether the person is attributed to Everstake — so "Jane Roe, CEO of Acme Labs, announced a
 * partnership with Everstake" survives from a tier-2 page. Pinned as current behaviour in
 * facts.test.ts; the fix is a proximity or attribution test, not a wider LIKE.
 */
function dropLeadershipFactsAboutOtherCompanies(): number {
  const result = run(
    `DELETE FROM facts WHERE key IN (${placeholders(PERSON_KEYS)}) AND lower(quote) NOT LIKE '%everstake%'
     AND doc_id IN (SELECT id FROM documents WHERE tier > 1 OR url LIKE '%/resources/blog/%' OR category = 'video')`,
    ...PERSON_KEYS);
  return Number(result.changes);
}

/**
 * A key that means a quantity must carry one. The model regularly answers `networks_supported`
 * with a list of network NAMES, or `uptime` with "ninety-nine percent" — values that read fine in
 * a quote but are useless to a question asking how many. GLOB '*[0-9]*' only asks for a digit
 * somewhere; the value is never parsed, so "founded in 2018" is kept as-is.
 */
function dropNumericFactsWithoutADigit(): number {
  const result = run(
    `DELETE FROM facts WHERE key IN (${placeholders(NUMERIC_KEYS)}) AND value NOT GLOB '*[0-9]*'`,
    ...NUMERIC_KEYS);
  return Number(result.changes);
}

/**
 * The ledger as the answerer and the UI read it: only live, canonical documents (a fact from a
 * dedup alias would let syndication vote twice), newest first within a key so the current value
 * leads and the older ones read as history, then by tier so first-party beats press on the same
 * day. `ai_directed` travels with each row so the caller can down-weight self-declarations.
 */
export function factLedger(key?: string) {
  return all(
    `SELECT f.id, f.key, f.value, f.as_of, f.as_of_source, f.quote, f.confidence, f.flags, d.id doc_id, d.url, d.title, d.tier, d.domain, d.ai_directed
     FROM facts f JOIN documents d ON d.id = f.doc_id
     WHERE d.status='ok' AND d.duplicate_of IS NULL ${key ? "AND f.key = ?" : ""}
     ORDER BY f.key, f.as_of DESC, d.tier`, ...(key ? [key] : []));
}
