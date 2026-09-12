// The fact ledger's post-model hygiene. These two SQL rules are the only thing standing between
// "a blog post quoted some other company's CEO" and "Everstake's CEO is <that person>", so they
// are pinned exactly. In-memory index, no model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { all, run, setDbPath } from "../db.js";

setDbPath(":memory:");
const { cleanFacts, factLedger, resolveFactAsOf } = await import("./facts.js");

// id, url, tier, category, published_at, status, duplicate_of
const DOCS: [number, string, number, string, string | null, string, number | null][] = [
  [1, "https://everstake.com/about", 1, "site", null, "ok", null],
  [2, "https://everstake.com/resources/blog/interview", 1, "blog", "2026-04-04", "ok", null],
  [3, "https://chainwire.org/pr", 2, "news", "2026-03-03", "ok", null],
  [4, "https://youtube.com/watch", 1, "video", "2026-02-02", "ok", null],
  [5, "https://everstake.com/gone", 1, "site", null, "dropped", null],
  [6, "https://mirror.test/copy", 2, "news", "2026-01-01", "ok", 3],
];
for (const [id, url, tier, category, published, status, dup] of DOCS) {
  run(`INSERT INTO documents (id, source_id, url, domain, category, tier, title, published_at, fetched_at, status, duplicate_of)
       VALUES (?,'s',?,'d.test',?,?,'T',?,'2026-09-10T00:00:00Z',?,?)`, id, url, category, tier, published, status, dup);
}

let factId = 0;
const addFact = (docId: number, key: string, value: string, quote: string, asOf: string | null = "2026-01-01") => {
  run(`INSERT INTO facts (id, doc_id, key, value, as_of, as_of_source, quote, confidence, flags) VALUES (?,?,?,?,?,'text',?,0.9,NULL)`,
    ++factId, docId, key, value, asOf, quote);
  return factId;
};
const survives = (id: number) => all<{ n: number }>("SELECT COUNT(*) n FROM facts WHERE id = ?", id)[0].n === 1;

// --- person rule ---------------------------------------------------------------------------
// on Everstake's own non-blog pages a bare "Sergii Vasylchuk — CEO" is unambiguous
const OWN_PAGE = addFact(1, "ceo", "Sergii Vasylchuk", "Sergii Vasylchuk, Chief Executive Officer");
const PRESS_NO_MENTION = addFact(3, "ceo", "Jane Roe", "Jane Roe, CEO of Acme Labs, commented");
const PRESS_WITH_MENTION = addFact(3, "founder", "Sergii Vasylchuk", "EVERSTAKE co-founder Sergii Vasylchuk");
const BLOG_NO_MENTION = addFact(2, "president", "Bob Loblaw", "Bob Loblaw, president of the foundation");
const VIDEO_NO_MENTION = addFact(4, "ccdo", "Ann Other", "Ann Other is the CCDO");
// suspected limitation, pinned as-is: the rule only asks whether the word "everstake" appears
// anywhere in the quote, not whether the person is attributed to Everstake
const PRESS_MISATTRIBUTED = addFact(3, "ceo", "Jane Roe", "Jane Roe, CEO of Acme Labs, announced a partnership with Everstake");

// --- numeric rule --------------------------------------------------------------------------
const NUMERIC_OK = addFact(1, "networks_supported", "130+", "supports 130+ networks");
const NUMERIC_NAMES = addFact(1, "networks_supported", "Ethereum, Solana, Cosmos", "supports Ethereum, Solana and Cosmos");
const UPTIME_WORDS = addFact(1, "uptime", "ninety-nine percent", "about ninety-nine percent");
const YEAR_IN_TEXT = addFact(1, "founded_year", "founded in 2018", "the company was founded in 2018");
// a key that is neither a person nor a numeric key keeps a digit-free value
const TEXTUAL_KEY = addFact(1, "custody_model", "non-custodial", "Everstake is non-custodial");

const REMOVED = cleanFacts();

test("a leadership fact on Everstake's own non-blog page survives without naming the company", () => {
  assert.equal(survives(OWN_PAGE), true);
});

test("a leadership fact from a third party is dropped unless the quote mentions Everstake", () => {
  assert.equal(survives(PRESS_NO_MENTION), false, "tier 2 and no mention → another company's executive");
  assert.equal(survives(PRESS_WITH_MENTION), true, "the mention test is case-insensitive");
});

test("Everstake's own blog and video pages are treated as third-party for leadership facts", () => {
  // interviews and conference talks are full of other companies' executives
  assert.equal(survives(BLOG_NO_MENTION), false, "tier 1, but the URL is under /resources/blog/");
  assert.equal(survives(VIDEO_NO_MENTION), false, "tier 1, but category='video'");
});

test("naming Everstake anywhere in the quote is enough to keep a misattributed leadership fact", () => {
  assert.equal(survives(PRESS_MISATTRIBUTED), true, "current behaviour: the CEO of another company survives the sieve");
});

test("a numeric key whose value carries no digit is dropped, whatever the key means", () => {
  assert.equal(survives(NUMERIC_OK), true);
  assert.equal(survives(NUMERIC_NAMES), false, "the model listed network names under networks_supported");
  assert.equal(survives(UPTIME_WORDS), false);
  assert.equal(survives(YEAR_IN_TEXT), true, "a digit anywhere in the value is enough — the value is not parsed");
});

test("keys outside the two rule sets are never touched", () => {
  assert.equal(survives(TEXTUAL_KEY), true);
});

test("cleanFacts reports how many rows it removed and removes nothing on a second pass", () => {
  assert.equal(REMOVED, 5, "3 unattributed leadership rows + 2 digit-free numeric rows");
  assert.equal(cleanFacts(), 0);
});

test("the ledger view hides dropped documents and dedup aliases", () => {
  addFact(5, "products", "Staking", "Everstake offers staking");
  addFact(6, "products", "Staking", "Everstake offers staking");
  const urls = new Set(factLedger().map((r: any) => r.url));
  assert.equal(urls.has("https://everstake.com/gone"), false, "status='dropped'");
  assert.equal(urls.has("https://mirror.test/copy"), false, "duplicate_of is set");
});

test("the ledger sorts by key, then newest as_of, then most authoritative tier", () => {
  addFact(1, "uptime", "99.98%", "Everstake uptime 99.98%", "2026-05-05");
  addFact(3, "uptime", "99.9%", "Everstake uptime 99.9%", "2026-05-05");
  addFact(1, "uptime", "99.5%", "Everstake uptime 99.5%", "2024-01-01");
  const rows = factLedger("uptime") as any[];
  assert.deepEqual(rows.map((r) => [r.value, r.as_of, r.tier]), [
    ["99.98%", "2026-05-05", 1],
    ["99.9%", "2026-05-05", 2],
    ["99.5%", "2024-01-01", 1],
  ]);
  assert.equal(factLedger("no_such_key").length, 0);
  assert.ok((factLedger() as any[]).length > rows.length, "no key argument returns every key");
});

// --- as_of priority chain ---------------------------------------------------------------------
// Every fact row carries the date it is true "as of" plus which of three sources that date came
// from. Ordering the ledger — and therefore which value the answerer treats as current — depends
// entirely on this, so each branch is pinned separately.
const LIVE_PAGE = { published_at: null, fetched_at: "2026-09-10T23:30:00Z", category: "site" };
const DATED_POST = { published_at: "2024-06-01", fetched_at: "2026-09-10T23:30:00Z", category: "blog" };
const UNDATED_NEWS = { published_at: null, fetched_at: "2026-09-10T23:30:00Z", category: "news" };

test("an explicit ISO date in the text outranks the document's own dates", () => {
  assert.deepEqual(resolveFactAsOf("2025-06-15", DATED_POST), { asOf: "2025-06-15", asOfSource: "text" });
  assert.deepEqual(resolveFactAsOf("2025-06-15", LIVE_PAGE), { asOf: "2025-06-15", asOfSource: "text" });
});

test("only a full YYYY-MM-DD counts as explicit; anything vaguer falls through the chain", () => {
  assert.deepEqual(resolveFactAsOf("2025", DATED_POST), { asOf: "2024-06-01", asOfSource: "document" });
  assert.deepEqual(resolveFactAsOf("June 2025", DATED_POST), { asOf: "2024-06-01", asOfSource: "document" });
  assert.deepEqual(resolveFactAsOf("", DATED_POST), { asOf: "2024-06-01", asOfSource: "document" });
  assert.deepEqual(resolveFactAsOf(null, DATED_POST), { asOf: "2024-06-01", asOfSource: "document" });
  // the shape is checked, not the calendar — an impossible date is still "explicit"
  assert.deepEqual(resolveFactAsOf("2026-13-45", DATED_POST), { asOf: "2026-13-45", asOfSource: "text" });
});

test("an undated site/docs/code page is current as of the fetch DAY, not the fetch instant", () => {
  assert.deepEqual(resolveFactAsOf(null, LIVE_PAGE), { asOf: "2026-09-10", asOfSource: "live-page" });
  for (const category of ["site", "docs", "code"]) {
    assert.equal(resolveFactAsOf(null, { ...LIVE_PAGE, category }).asOfSource, "live-page", category);
  }
});

test("the live-page rule needs BOTH no publication date and an evergreen category", () => {
  // a dated site page is dated, not live
  assert.deepEqual(resolveFactAsOf(null, { ...LIVE_PAGE, published_at: "2023-01-01" }),
    { asOf: "2023-01-01", asOfSource: "document" });
  // an undated news article gets no date at all rather than a borrowed one
  assert.deepEqual(resolveFactAsOf(null, UNDATED_NEWS), { asOf: null, asOfSource: null });
  assert.deepEqual(resolveFactAsOf("not a date", UNDATED_NEWS), { asOf: null, asOfSource: null });
});
