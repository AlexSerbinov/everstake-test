/* Demo mode: ?mock=1 replays a realistic /ask/stream sequence with delays,
   so the whole experience can be shown before the backend stream is live.
   Same event contract as docs/agentic-spec.md — the UI cannot tell them apart. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);

const SRC = {
  about:  { url: "https://everstake.com/company/about", title: "About Everstake: Crypto Staking and Validator Infrastructure", domain: "everstake.com", tier: 1 },
  mcp:    { url: "https://everstake.com/mcp", title: "Everstake MCP Server: Staking Data for AI Agents", domain: "everstake.com", tier: 1 },
  docs:   { url: "https://docs.everstake.com/integrations/everstake-products/mcp-server/endpoints.md", title: "Endpoints — Everstake MCP Server", domain: "docs.everstake.com", tier: 1 },
  nexus:  { url: "https://everstake.com/resources/blog/everstake-and-nexus-mutual-are-to-protect-delegators-from-eth-staking-risks", title: "Everstake & Nexus Mutual Protect Users From Staking Risks", domain: "everstake.com", tier: 1 },
  press:  { url: "https://cointelegraph.com/press-releases/everstake-expands-validator-footprint", title: "Everstake expands its validator footprint across 85 networks", domain: "cointelegraph.com", tier: 2 },
  yt:     { url: "https://www.youtube.com/watch?v=Ck3nAQ1a2vE", title: "Everstake at Devcon — infrastructure panel (ASR)", domain: "youtube.com", tier: 3 },
  careers:{ url: "https://everstake.com/company/careers", title: "Help Shape the Future of Web3 with Everstake", domain: "everstake.com", tier: 1 },
};
const hit = (s, n, date, score) => ({ n, url: s.url, title: s.title, domain: s.domain, tier: s.tier, date, score });

function candidates(list) {
  return list.map((c, i) => ({
    chunk_id: 2100 + i * 7, doc_id: 20 + i, url: c.url, title: c.title, domain: c.domain, tier: c.tier,
    published_at: c.date_kind === "live" ? null : c.date, effective_date: c.date, date_kind: c.date_kind || "published",
    ai_directed: 0, bm25_rank: c.bm25 ?? null, vec_rank: c.vec ?? null, cosine: c.cos ?? null,
    rrf: +(0.031 - i * 0.0011).toFixed(5), recency: c.rec ?? 0.99, authority: c.tier === 1 ? 1 : c.tier === 2 ? 0.6 : 0.35,
    score: +(c.score).toFixed(5),
  }));
}

/* ── scenario A: answered ─────────────────────────────────────────────── */
const answeredCands = candidates([
  { ...SRC.docs,  date: TODAY, date_kind: "live", bm25: 9,  vec: 1,  cos: 0.7535, score: 0.01584 },
  { ...SRC.mcp,   date: TODAY, date_kind: "live", bm25: 3,  vec: 4,  cos: 0.7312, score: 0.01535 },
  { ...SRC.about, date: TODAY, date_kind: "live", bm25: 1,  vec: 2,  cos: 0.7501, score: 0.01426 },
  { ...SRC.careers,date: TODAY, date_kind: "live", bm25: 6, vec: 9,  cos: 0.6902, score: 0.01011 },
  { ...SRC.press, date: "2024-03-18", bm25: 12, vec: 6, cos: 0.7104, rec: 0.61, score: 0.00588 },
  { ...SRC.yt,    date: "2023-11-14", bm25: 22, vec: 11, cos: 0.6631, rec: 0.44, score: 0.00402 },
  { ...SRC.nexus, date: "2022-11-29", bm25: 31, vec: 18, cos: 0.6402, rec: 0.31, score: 0.00316 },
]);

const ANSWERED = (question) => ({
  events: [
    [180,  "stage", { id: "plan", label: "Planning the approach", status: "start" }],
    [520,  "stage", { id: "plan", status: "done", ms: 512, detail: { intent: "factual", needs_history: true, plan: "search corpus → fact ledger → verify against the live company page" } }],
    [60,   "stage", { id: "search", label: "Searching the corpus", status: "start" }],
    [40,   "tool_call", { step: 1, tool: "search_corpus", args: { query: "how many networks Everstake supports", min_year: null, k: 40 }, label: "Searching 2 138 chunks" }],
    [780,  "tool_result", { step: 1, tool: "search_corpus", summary: "14 chunks, best score 0.0158", ms: 741,
             items: [hit(SRC.docs, 3, TODAY, 0.01584), hit(SRC.mcp, 4, TODAY, 0.01535), hit(SRC.about, 7, TODAY, 0.01426), hit(SRC.careers, 9, TODAY, 0.01011), hit(SRC.press, 11, "2024-03-18", 0.00588), hit(SRC.yt, 12, "2023-11-14", 0.00402), hit(SRC.nexus, 13, "2022-11-29", 0.00316)] }],
    [120,  "stage", { id: "search", status: "done", ms: 902 }],
    [60,   "stage", { id: "facts", label: "Reading the fact ledger", status: "start" }],
    [40,   "tool_call", { step: 2, tool: "fact_history", args: { key: "networks_supported" }, label: "networks_supported — full history" }],
    [420,  "tool_result", { step: 2, tool: "fact_history", summary: "4 distinct values across 41 pages", ms: 388,
             items: [
               { key: "networks_supported", value: "130+", as_of: TODAY, url: SRC.about.url, domain: "everstake.com" },
               { key: "networks_supported", value: "85+", as_of: "2024-03-18", url: SRC.press.url, domain: "cointelegraph.com" },
               { key: "networks_supported", value: "70+", as_of: "2022-11-29", url: SRC.nexus.url, domain: "everstake.com" },
               { key: "networks_supported", value: "45", as_of: "2021-06-02", url: SRC.yt.url, domain: "youtube.com" },
             ] }],
    [140,  "stage", { id: "facts", status: "done", ms: 566 }],
    [80,   "note", { text: "The ledger disagrees across years (45 → 70+ → 85+ → 130+). That is a history, not a conflict — I will date each value rather than pick one." }],
    [220,  "stage", { id: "live", label: "Checking the live page", status: "start" }],
    [40,   "tool_call", { step: 3, tool: "fetch_live_page", args: { url: "https://everstake.com/company/about" }, label: "everstake.com/company/about" }],
    [1180, "tool_result", { step: 3, tool: "fetch_live_page", summary: `fetched, 4 812 chars, live_page_as_of=${TODAY}`, ms: 1142,
             items: [hit(SRC.about, 7, TODAY, 0.01426)] }],
    [120,  "stage", { id: "live", status: "done", ms: 1348 }],
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
      sources: [
        { n: 3, ...SRC.docs, published_at: null, effective_date: TODAY, date_kind: "live", kind: "chunk", score: 0.01584,
          quote: "SDK enabling wallets, exchanges, and fintech apps to embed staking functionality across 130+ supported networks. Provides seamless access to Everstake's staking infrastructure without managing validators directly." },
        { n: 4, ...SRC.mcp, published_at: null, effective_date: TODAY, date_kind: "live", kind: "chunk", score: 0.01535,
          quote: "Total staked $7B+ · Networks 130+ — Everstake serves 1.6M+ delegators with over $7B in total staked value across 130+ Proof-of-Stake networks." },
        { n: 7, ...SRC.about, published_at: null, effective_date: TODAY, date_kind: "live", kind: "fact", score: 0.01426,
          quote: "Everstake is a global provider of staking infrastructure. Founded in 2018 … $7B+ Staked Value Secured · 130+ Networks Supported · 99.98% Observed Infrastructure Uptime." },
        { n: 13, ...SRC.nexus, published_at: "2022-11-29", effective_date: "2022-11-29", date_kind: "published", kind: "chunk", score: 0.00316,
          quote: "Everstake, a validator supporting over 70 blockchains, partnered with Nexus Mutual to offer ETH Staking Coverage, which protects users against penalties, slashing events, and missed rewards." },
      ],
      trace: {
        fts_query: '"networks" OR "everstake" OR "support"', vector_used: true,
        candidates: answeredCands,
        selected: answeredCands.slice(0, 4).map((c, i) => ({ chunk_id: c.chunk_id, selected_by: i === 3 ? "date-diverse" : "top" }))
          .concat([{ chunk_id: answeredCands[6].chunk_id, selected_by: "date-diverse" }]),
        facts: [
          { key: "networks_supported", value: "130+", as_of: TODAY, url: SRC.about.url, tier: 1, quote: "130+ Networks Supported" },
          { key: "networks_supported", value: "70+", as_of: "2022-11-29", url: SRC.nexus.url, tier: 1, quote: "a validator supporting over 70 blockchains" },
        ],
        model: "gemini-3.8-flash", usage: { input: 8412, output: 214 }, cost_usd: 0.00312, latency_ms: 6104,
        config: { ranking: { recency_half_life_days: 540, tier_weights: { 1: 1, 2: 0.6, 3: 0.35 } } },
      },
    }],
  ],
});

/* ── scenario B: no reliable answer ───────────────────────────────────── */
const REFUSED = (question) => ({
  events: [
    [180,  "stage", { id: "plan", label: "Planning the approach", status: "start" }],
    [430,  "stage", { id: "plan", status: "done", ms: 421, detail: { intent: "factual", plan: "search corpus for compensation figures; abstain if nothing first-party" } }],
    [60,   "stage", { id: "search", label: "Searching the corpus", status: "start" }],
    [40,   "tool_call", { step: 1, tool: "search_corpus", args: { query: "Everstake CEO salary compensation" }, label: "Searching 2 138 chunks" }],
    [690,  "tool_result", { step: 1, tool: "search_corpus", summary: "6 chunks, best score 0.0031 — below the gate (0.005)", ms: 654,
             items: [hit(SRC.about, 1, TODAY, 0.00312), hit(SRC.careers, 2, TODAY, 0.00241), hit(SRC.press, 3, "2024-03-18", 0.00118)] }],
    [120,  "stage", { id: "search", status: "done", ms: 814 }],
    [80,   "note", { text: "Nothing in the corpus talks about executive pay. Re-running the search with a broader query before giving up." }],
    [180,  "stage", { id: "search", label: "Searching the corpus (retry, broader)", status: "start" }],
    [40,   "tool_call", { step: 2, tool: "search_corpus", args: { query: "Everstake leadership compensation remuneration", k: 60 }, label: "Widened query, 60 candidates" }],
    [620,  "tool_result", { step: 2, tool: "search_corpus", summary: "0 chunks above the score floor", ms: 588, items: [] }],
    [120,  "stage", { id: "search", status: "done", ms: 782 }],
    [60,   "stage", { id: "facts", label: "Reading the fact ledger", status: "start" }],
    [40,   "tool_call", { step: 3, tool: "fact_history", args: { key: "ceo" }, label: "ceo — closest key in the ledger" }],
    [300,  "tool_result", { step: 3, tool: "fact_history", summary: "1 value — name only, no compensation", ms: 271,
             items: [{ key: "ceo", value: "Sergii Vasylchuk", as_of: TODAY, url: SRC.about.url, domain: "everstake.com" }] }],
    [120,  "stage", { id: "facts", status: "done", ms: 434 }],
    [60,   "stage", { id: "live", label: "Checking the live page", status: "skip", ms: 0 }],
    [60,   "stage", { id: "answer", label: "Drafting the answer", status: "skip", ms: 0 }],
    [140,  "stage", { id: "verify", label: "Checking the evidence gate", status: "start" }],
    [280,  "stage", { id: "verify", status: "done", ms: 268, detail: { gate: "gate1_no_evidence", best_score: 0.00312, min_best_score: 0.005 } }],
    [180,  "final", {
      question,
      status: "no_reliable_answer", mode: null,
      answer: "The corpus contains no source that states any compensation figure for Everstake's CEO. Executive pay is not disclosed on the company's public pages, and nothing in the indexed press or video material covers it.",
      as_of: null, confidence: 0, gate: "gate1_no_evidence", citations: [], sources: [],
      trace: {
        fts_query: '"everstake" OR "ceo" OR "salary"', vector_used: true,
        candidates: candidates([
          { ...SRC.about, date: TODAY, date_kind: "live", bm25: 2, vec: 5, cos: 0.5412, score: 0.00312 },
          { ...SRC.careers, date: TODAY, date_kind: "live", bm25: 4, vec: 8, cos: 0.5218, score: 0.00241 },
          { ...SRC.press, date: "2024-03-18", bm25: 14, vec: 21, cos: 0.4901, rec: 0.61, score: 0.00118 },
        ]),
        selected: [], facts: [], model: null, usage: null, cost_usd: 0.00008, latency_ms: 3120,
        config: { ranking: { recency_half_life_days: 540, tier_weights: { 1: 1, 2: 0.6, 3: 0.35 } } },
      },
    }],
  ],
});

const REFUSE_RE = /salary|wi-?fi|password|revenue|profit|how much does .* earn|valuation|net worth/i;

export async function mockStream(question, onEvent, signal) {
  const script = (REFUSE_RE.test(question) ? REFUSED : ANSWERED)(question);
  for (const [delay, type, data] of script.events) {
    await sleep(delay);
    if (signal?.aborted) return;
    onEvent(type, data);
  }
}

export const isMock = () => new URLSearchParams(location.search).get("mock") === "1";
