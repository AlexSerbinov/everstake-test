/**
 * Demo mode: a scripted replay of POST /ask/stream, entirely client-side.
 *
 * Where this sits: it stands in for the whole backend pipeline
 * (crawl → dedup → index → facts → retrieve → answer → eval) so the UI can be
 * shown with no server, no API keys, no database and no model spend — on a laptop
 * during a call, or from a static host.
 *
 * It emits exactly the event contract in docs/agentic-spec.md, in the same order
 * and with the same payload field names as src/ask/agent.ts, so app.js and
 * pipeline.js cannot tell a replay from a live run. That is the whole design
 * constraint: if this file drifted from the spec, demo mode would start proving
 * that the UI works on data the real backend never sends.
 *
 * The delays are hand-tuned to the timings a real run produced — they are what
 * makes the pipeline panel legible instead of flashing past.
 *
 * Nothing here is evidence. The quotes and figures are copied from real Everstake
 * pages so the demo reads truthfully, but a reviewer judging the system must run
 * it without `?mock=1`; the corner flag in app.js says so on screen.
 */

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/* Live-fetched pages are dated "today" in a real run, so the replay follows the
   clock. Hard-coding a date would make the demo look stale within a week. */
const TODAY = new Date().toISOString().slice(0, 10);

/* The pages the scripted run "retrieves". Tier 1 = first-party, 2 = press,
   3 = video/social — the same tiers the real ranker weights. */
const SOURCES = {
  about:  { url: "https://everstake.com/company/about", title: "About Everstake: Crypto Staking and Validator Infrastructure", domain: "everstake.com", tier: 1 },
  mcp:    { url: "https://everstake.com/mcp", title: "Everstake MCP Server: Staking Data for AI Agents", domain: "everstake.com", tier: 1 },
  docs:   { url: "https://docs.everstake.com/integrations/everstake-products/mcp-server/endpoints.md", title: "Endpoints — Everstake MCP Server", domain: "docs.everstake.com", tier: 1 },
  nexus:  { url: "https://everstake.com/resources/blog/everstake-and-nexus-mutual-are-to-protect-delegators-from-eth-staking-risks", title: "Everstake & Nexus Mutual Protect Users From Staking Risks", domain: "everstake.com", tier: 1 },
  press:  { url: "https://cointelegraph.com/press-releases/everstake-expands-validator-footprint", title: "Everstake expands its validator footprint across 85 networks", domain: "cointelegraph.com", tier: 2 },
  yt:     { url: "https://www.youtube.com/watch?v=Ck3nAQ1a2vE", title: "Everstake at Devcon — infrastructure panel (ASR)", domain: "youtube.com", tier: 3 },
  careers:{ url: "https://everstake.com/company/careers", title: "Help Shape the Future of Web3 with Everstake", domain: "everstake.com", tier: 1 },
};

/**
 * One row of a `tool_result` items list: a source with its citation number, date
 * and score, which is the shape pipeline.js draws score bars from.
 */
const searchHit = (source, citationNumber, date, score) => ({
  n: citationNumber,
  url: source.url,
  title: source.title,
  domain: source.domain,
  tier: source.tier,
  date,
  score,
});

/**
 * Expand shorthand rows into the full candidate records the retrieval trace table
 * expects — every column the real ranker reports, so the table in the demo has no
 * empty cells that would be filled in a live run.
 *
 * The derived values are the real formulas: authority comes from the tier, and rrf
 * decays with rank position the way reciprocal-rank fusion does.
 */
function toCandidateRows(rows) {
  return rows.map((row, index) => ({
    /* Stable synthetic ids. Only their identity matters: `selected` refers back to
       chunk_id, and the trace table links to doc_id. */
    chunk_id: 2100 + index * 7,
    doc_id: 20 + index,
    url: row.url,
    title: row.title,
    domain: row.domain,
    tier: row.tier,
    /* A live-fetched page has no publication date — its date is the fetch date,
       which is exactly the distinction `date_kind` carries into the UI. */
    published_at: row.date_kind === "live" ? null : row.date,
    effective_date: row.date,
    date_kind: row.date_kind || "published",
    ai_directed: 0,
    bm25_rank: row.bm25 ?? null,
    vec_rank: row.vec ?? null,
    cosine: row.cos ?? null,
    rrf: +(0.031 - index * 0.0011).toFixed(5),
    recency: row.rec ?? 0.99,
    authority: row.tier === 1 ? 1 : row.tier === 2 ? 0.6 : 0.35,
    score: +(row.score).toFixed(5),
  }));
}

/* ---------------------------------------------------------------------------
   Scenario A — a question the corpus can answer
   --------------------------------------------------------------------------- */

/* Deliberately spans 2022-2026 and all three tiers: it is what makes the recency
   decay and the date-diversity pick visible in the trace table. */
const ANSWERED_CANDIDATES = toCandidateRows([
  { ...SOURCES.docs,  date: TODAY, date_kind: "live", bm25: 9,  vec: 1,  cos: 0.7535, score: 0.01584 },
  { ...SOURCES.mcp,   date: TODAY, date_kind: "live", bm25: 3,  vec: 4,  cos: 0.7312, score: 0.01535 },
  { ...SOURCES.about, date: TODAY, date_kind: "live", bm25: 1,  vec: 2,  cos: 0.7501, score: 0.01426 },
  { ...SOURCES.careers,date: TODAY, date_kind: "live", bm25: 6, vec: 9,  cos: 0.6902, score: 0.01011 },
  { ...SOURCES.press, date: "2024-03-18", bm25: 12, vec: 6, cos: 0.7104, rec: 0.61, score: 0.00588 },
  { ...SOURCES.yt,    date: "2023-11-14", bm25: 22, vec: 11, cos: 0.6631, rec: 0.44, score: 0.00402 },
  { ...SOURCES.nexus, date: "2022-11-29", bm25: 31, vec: 18, cos: 0.6402, rec: 0.31, score: 0.00316 },
]);

/**
 * "How many networks does Everstake support?" — the flagship demo.
 *
 * It is chosen because the honest answer is a history, not a number: the ledger
 * holds 45 → 70+ → 85+ → 130+ across five years. The scripted run therefore shows
 * the agent noticing the disagreement, checking the live page, and dating its
 * answer instead of picking the newest row.
 *
 * Each entry is [delay before it, event type, payload].
 */
const answeredScenario = (question) => [
  [180,  "stage", { id: "plan", label: "Planning the approach", status: "start" }],
  [520,  "stage", { id: "plan", status: "done", ms: 512, detail: { intent: "factual", needs_history: true, plan: "search corpus → fact ledger → verify against the live company page" } }],
  [60,   "stage", { id: "search", label: "Searching the corpus", status: "start" }],
  [40,   "tool_call", { step: 1, tool: "search_corpus", args: { query: "how many networks Everstake supports", min_year: null, k: 40 }, label: "Searching 2 138 chunks" }],
  [780,  "tool_result", { step: 1, tool: "search_corpus", summary: "14 chunks, best score 0.0158", ms: 741,
           items: [searchHit(SOURCES.docs, 3, TODAY, 0.01584), searchHit(SOURCES.mcp, 4, TODAY, 0.01535), searchHit(SOURCES.about, 7, TODAY, 0.01426), searchHit(SOURCES.careers, 9, TODAY, 0.01011), searchHit(SOURCES.press, 11, "2024-03-18", 0.00588), searchHit(SOURCES.yt, 12, "2023-11-14", 0.00402), searchHit(SOURCES.nexus, 13, "2022-11-29", 0.00316)] }],
  [120,  "stage", { id: "search", status: "done", ms: 902 }],
  [60,   "stage", { id: "facts", label: "Reading the fact ledger", status: "start" }],
  [40,   "tool_call", { step: 2, tool: "fact_history", args: { key: "networks_supported" }, label: "networks_supported — full history" }],
  [420,  "tool_result", { step: 2, tool: "fact_history", summary: "4 distinct values across 41 pages", ms: 388,
           items: [
             { key: "networks_supported", value: "130+", as_of: TODAY, url: SOURCES.about.url, domain: "everstake.com" },
             { key: "networks_supported", value: "85+", as_of: "2024-03-18", url: SOURCES.press.url, domain: "cointelegraph.com" },
             { key: "networks_supported", value: "70+", as_of: "2022-11-29", url: SOURCES.nexus.url, domain: "everstake.com" },
             { key: "networks_supported", value: "45", as_of: "2021-06-02", url: SOURCES.yt.url, domain: "youtube.com" },
           ] }],
  [140,  "stage", { id: "facts", status: "done", ms: 566 }],
  [80,   "note", { text: "The ledger disagrees across years (45 → 70+ → 85+ → 130+). That is a history, not a conflict — I will date each value rather than pick one." }],
  [220,  "stage", { id: "live", label: "Checking the live page", status: "start" }],
  [40,   "tool_call", { step: 3, tool: "fetch_live_page", args: { url: "https://everstake.com/company/about" }, label: "everstake.com/company/about" }],
  [1180, "tool_result", { step: 3, tool: "fetch_live_page", summary: `fetched, 4 812 chars, live_page_as_of=${TODAY}`, ms: 1142,
           items: [searchHit(SOURCES.about, 7, TODAY, 0.01426)] }],
  [120,  "stage", { id: "live", status: "done", ms: 1348 }],
  /* Shown as skipped rather than omitted: a stage the agent chose not to run is
     itself information about how it reasoned. */
  [60,   "stage", { id: "read", label: "Reading a document", status: "skip", ms: 0 }],
  [140,  "stage", { id: "answer", label: "Drafting the answer", status: "start" }],
  [1900, "stage", { id: "answer", status: "done", ms: 1893, detail: { model: "gemini-3.8-flash", tokens_in: 8412, tokens_out: 214 } }],
  [80,   "stage", { id: "verify", label: "Verifying citations", status: "start" }],
  [340,  "stage", { id: "verify", status: "done", ms: 331, detail: { cited: "3, 4, 7, 13", all_in_provided_sources: true, gate2: "passed" } }],
  [180,  "final", {
    question,
    status: "answered", mode: "factual",
    answer: "Everstake supports 130+ blockchain networks [3, 4, 7]. That figure is what the company's own pages state today; the number has grown over time — press coverage reported 85+ networks in March 2024, and Everstake's own blog cited over 70 blockchains in November 2022 [13].",
    as_of: TODAY, confidence: 0.94, gate: "none",
    citations: [3, 4, 7, 13],
    /* Citation numbers are not 1..n: they are the numbers the retriever assigned
       across all candidates, and the answer cites a subset. app.js anchors source
       cards on these, so they must match the `[n]` markers in `answer` above. */
    sources: [
      { n: 3, ...SOURCES.docs, published_at: null, effective_date: TODAY, date_kind: "live", kind: "chunk", score: 0.01584,
        quote: "SDK enabling wallets, exchanges, and fintech apps to embed staking functionality across 130+ supported networks. Provides seamless access to Everstake's staking infrastructure without managing validators directly." },
      { n: 4, ...SOURCES.mcp, published_at: null, effective_date: TODAY, date_kind: "live", kind: "chunk", score: 0.01535,
        quote: "Total staked $7B+ · Networks 130+ — Everstake serves 1.6M+ delegators with over $7B in total staked value across 130+ Proof-of-Stake networks." },
      { n: 7, ...SOURCES.about, published_at: null, effective_date: TODAY, date_kind: "live", kind: "fact", score: 0.01426,
        quote: "Everstake is a global provider of staking infrastructure. Founded in 2018 … $7B+ Staked Value Secured · 130+ Networks Supported · 99.98% Observed Infrastructure Uptime." },
      { n: 13, ...SOURCES.nexus, published_at: "2022-11-29", effective_date: "2022-11-29", date_kind: "published", kind: "chunk", score: 0.00316,
        quote: "Everstake, a validator supporting over 70 blockchains, partnered with Nexus Mutual to offer ETH Staking Coverage, which protects users against penalties, slashing events, and missed rewards." },
    ],
    trace: {
      fts_query: '"networks" OR "everstake" OR "support"', vector_used: true,
      candidates: ANSWERED_CANDIDATES,
      /* The top 4 by score, plus the 2022 blog pulled in for date diversity —
         which is what lets the answer state the history rather than only today. */
      selected: ANSWERED_CANDIDATES.slice(0, 4)
        .map((candidate, index) => ({
          chunk_id: candidate.chunk_id,
          selected_by: index === 3 ? "date-diverse" : "top",
        }))
        .concat([{ chunk_id: ANSWERED_CANDIDATES[6].chunk_id, selected_by: "date-diverse" }]),
      facts: [
        { key: "networks_supported", value: "130+", as_of: TODAY, url: SOURCES.about.url, tier: 1, quote: "130+ Networks Supported" },
        { key: "networks_supported", value: "70+", as_of: "2022-11-29", url: SOURCES.nexus.url, tier: 1, quote: "a validator supporting over 70 blockchains" },
      ],
      model: "gemini-3.8-flash", usage: { input: 8412, output: 214 }, cost_usd: 0.00312, latency_ms: 6104,
      config: { ranking: { recency_half_life_days: 540, tier_weights: { 1: 1, 2: 0.6, 3: 0.35 } } },
    },
  }],
];

/* ---------------------------------------------------------------------------
   Scenario B — a question the corpus cannot answer
   --------------------------------------------------------------------------- */

/**
 * "What is the salary of Everstake's CEO?" — the trap.
 *
 * This scenario exists because refusing is the graded behaviour, not a fallback.
 * It deliberately shows the agent trying twice (a broader query, then the closest
 * ledger key) before gate 1 stops it: an abstention is only credible if the search
 * that preceded it is visible.
 */
const refusedScenario = (question) => [
  [180,  "stage", { id: "plan", label: "Planning the approach", status: "start" }],
  [430,  "stage", { id: "plan", status: "done", ms: 421, detail: { intent: "factual", plan: "search corpus for compensation figures; abstain if nothing first-party" } }],
  [60,   "stage", { id: "search", label: "Searching the corpus", status: "start" }],
  [40,   "tool_call", { step: 1, tool: "search_corpus", args: { query: "Everstake CEO salary compensation" }, label: "Searching 2 138 chunks" }],
  [690,  "tool_result", { step: 1, tool: "search_corpus", summary: "6 chunks, best score 0.0031 — below the gate (0.005)", ms: 654,
           items: [searchHit(SOURCES.about, 1, TODAY, 0.00312), searchHit(SOURCES.careers, 2, TODAY, 0.00241), searchHit(SOURCES.press, 3, "2024-03-18", 0.00118)] }],
  [120,  "stage", { id: "search", status: "done", ms: 814 }],
  [80,   "note", { text: "Nothing in the corpus talks about executive pay. Re-running the search with a broader query before giving up." }],
  [180,  "stage", { id: "search", label: "Searching the corpus (retry, broader)", status: "start" }],
  [40,   "tool_call", { step: 2, tool: "search_corpus", args: { query: "Everstake leadership compensation remuneration", k: 60 }, label: "Widened query, 60 candidates" }],
  [620,  "tool_result", { step: 2, tool: "search_corpus", summary: "0 chunks above the score floor", ms: 588, items: [] }],
  [120,  "stage", { id: "search", status: "done", ms: 782 }],
  [60,   "stage", { id: "facts", label: "Reading the fact ledger", status: "start" }],
  [40,   "tool_call", { step: 3, tool: "fact_history", args: { key: "ceo" }, label: "ceo — closest key in the ledger" }],
  [300,  "tool_result", { step: 3, tool: "fact_history", summary: "1 value — name only, no compensation", ms: 271,
           items: [{ key: "ceo", value: "Sergii Vasylchuk", as_of: TODAY, url: SOURCES.about.url, domain: "everstake.com" }] }],
  [120,  "stage", { id: "facts", status: "done", ms: 434 }],
  [60,   "stage", { id: "live", label: "Checking the live page", status: "skip", ms: 0 }],
  /* The answer stage is skipped, not failed: gate 1 fires before the model is
     called at all, so nothing was generated and nothing could be invented. */
  [60,   "stage", { id: "answer", label: "Drafting the answer", status: "skip", ms: 0 }],
  [140,  "stage", { id: "verify", label: "Checking the evidence gate", status: "start" }],
  [280,  "stage", { id: "verify", status: "done", ms: 268, detail: { gate: "gate1_no_evidence", best_score: 0.00312, min_best_score: 0.005 } }],
  [180,  "final", {
    question,
    status: "no_reliable_answer", mode: null,
    /* There is still prose here, and it is a statement about the corpus, not an
       answer to the question — which is what app.js renders as "what it said". */
    answer: "The corpus contains no source that states any compensation figure for Everstake's CEO. Executive pay is not disclosed on the company's public pages, and nothing in the indexed press or video material covers it.",
    as_of: null, confidence: 0, gate: "gate1_no_evidence", citations: [], sources: [],
    trace: {
      fts_query: '"everstake" OR "ceo" OR "salary"', vector_used: true,
      candidates: toCandidateRows([
        { ...SOURCES.about, date: TODAY, date_kind: "live", bm25: 2, vec: 5, cos: 0.5412, score: 0.00312 },
        { ...SOURCES.careers, date: TODAY, date_kind: "live", bm25: 4, vec: 8, cos: 0.5218, score: 0.00241 },
        { ...SOURCES.press, date: "2024-03-18", bm25: 14, vec: 21, cos: 0.4901, rec: 0.61, score: 0.00118 },
      ]),
      /* Nothing selected and no model called — the cost is the embedding of the
         query alone, which is what makes a refusal cheap as well as safe. */
      selected: [], facts: [], model: null, usage: null, cost_usd: 0.00008, latency_ms: 3120,
      config: { ranking: { recency_half_life_days: 540, tier_weights: { 1: 1, 2: 0.6, 3: 0.35 } } },
    },
  }],
];

/**
 * Questions that route to the refusal scenario.
 *
 * Two kinds are matched. Undisclosed business figures (salary, revenue, profit,
 * valuation, net worth) are the honest "the corpus does not contain this" case.
 * The `wi-?fi|password` pair covers the other reason to refuse: a question the
 * corpus has no business answering at all, which is the demo's answer to
 * "what if someone tries prompt injection through the question box".
 *
 * Matches anywhere in the question, case-insensitively — the example chips in
 * index.html are phrased so that exactly one of them lands here.
 */
const REFUSAL_QUESTION_PATTERN =
  /salary|wi-?fi|password|revenue|profit|how much does .* earn|valuation|net worth/i;

/**
 * Replay a scenario through `onEvent`, matching the signature of `streamAsk` so
 * app.js can swap one for the other with a single flag.
 *
 * The abort check sits after the sleep, not before it, so a cancelled replay stops
 * at the next event rather than running to the end in the background.
 */
export async function replayMockStream(question, onEvent, signal) {
  const scenario = REFUSAL_QUESTION_PATTERN.test(question)
    ? refusedScenario(question)
    : answeredScenario(question);

  for (const [delayMs, eventType, payload] of scenario) {
    await sleep(delayMs);
    if (signal?.aborted) return;
    onEvent(eventType, payload);
  }
}

/** `?mock=1` in the URL is the only way demo mode turns on — never a build flag. */
export const isMockModeEnabled = () =>
  new URLSearchParams(location.search).get("mock") === "1";
