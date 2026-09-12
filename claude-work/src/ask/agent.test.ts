// Deterministic parts of the agent layer: the citation gate, the live-fetch allow-list,
// the SSE event shapes the UI depends on, and the MCP's SSE envelope. No network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceRegistry, validateCitations } from "./shared.js";
import { firstSseJson, isLiveFetchAllowed } from "./tools.js";
import { normaliseFinish, stageEvent, toolCallEvent } from "./agent.js";

const chunk = (url: string, text: string) => ({
  chunk_id: url.length, doc_id: 1, url, title: "T", published_at: "2026-01-01", tier: 1, domain: "everstake.com",
  ai_directed: 0, category: "site", fetched_at: "2026-09-11", date_kind: "published" as const, effective_date: "2026-01-01",
  text, bm25_rank: 1, vec_rank: 1, cosine: 0.5, rrf: 0.03, recency: 1, authority: 1, score: 0.03,
});

test("gate 2: only source numbers a tool actually returned survive", () => {
  const reg = new SourceRegistry();
  reg.addChunks([chunk("https://everstake.com/a", "alpha"), chunk("https://everstake.com/bb", "beta")]);
  assert.deepEqual(reg.sources.map((s) => s.n), [1, 2]);
  // the model claims [1, 2, 9, 1, -3]: duplicates collapse, invented numbers are dropped
  assert.deepEqual(validateCitations(reg, [1, 2, 9, 1, -3]), [1, 2]);
  // an answer that cites nothing real leaves an empty list → caller downgrades to no_reliable_answer
  assert.deepEqual(validateCitations(reg, [7, 8]), []);
  // numbers are stable across calls: re-adding the same chunk does not mint a new one
  reg.addChunks([chunk("https://everstake.com/a", "alpha")]);
  assert.equal(reg.sources.length, 2);
});

test("fetch_live_page allow-list: host equality and path prefixes only, https only", () => {
  const allow = ["everstake.com", "docs.everstake.com", "github.com/everstake"];
  assert.ok(isLiveFetchAllowed("https://everstake.com/about", allow));
  assert.ok(isLiveFetchAllowed("https://www.everstake.com/", allow));
  assert.ok(isLiveFetchAllowed("https://docs.everstake.com/x/y", allow));
  assert.ok(isLiveFetchAllowed("https://github.com/everstake/wallet-sdk", allow));
  assert.equal(isLiveFetchAllowed("https://github.com/someone-else/repo", allow), false, "path prefix must match");
  assert.equal(isLiveFetchAllowed("https://everstake.com.evil.io/about", allow), false, "suffix trick");
  assert.equal(isLiveFetchAllowed("https://evil.io/?x=everstake.com", allow), false);
  assert.equal(isLiveFetchAllowed("http://everstake.com/about", allow), false, "https only");
  assert.equal(isLiveFetchAllowed("not a url", allow), false);
});

test("SSE events carry the shape the UI reads", () => {
  assert.deepEqual(stageEvent("search", "start"), { event: "stage", data: { id: "search", label: "Searching the corpus", status: "start" } });
  assert.deepEqual(stageEvent("live", "skip"), { event: "stage", data: { id: "live", label: "Checking live sources", status: "skip" } });
  assert.deepEqual(stageEvent("verify", "done", 12, { gate: "none" }),
    { event: "stage", data: { id: "verify", label: "Verifying citations", status: "done", ms: 12, detail: { gate: "none" } } });

  const e = toolCallEvent(2, "search_corpus", { query: "CEO Everstake", min_year: null });
  assert.equal(e.event, "tool_call");
  assert.deepEqual((e as any).data.args, { query: "CEO Everstake", min_year: null });
  assert.match((e as any).data.label, /Searching the corpus for/);
});

test("finish arguments are coerced to the same shape the single-shot path validates", () => {
  const a = normaliseFinish({ status: "answered", mode: "factual", answer: "x [1]", as_of: "2026-09-11", citations: [1, "2", null], confidence: 1.4 });
  assert.deepEqual(a, { status: "answered", mode: "factual", answer: "x [1]", as_of: "2026-09-11", citations: [1, 2], confidence: 1 });
  assert.equal(normaliseFinish({ as_of: "recently" }).as_of, null, "a non-ISO as_of is not a date");
});

test("MCP streamable-HTTP responses are SSE lines", () => {
  assert.deepEqual(firstSseJson('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"99.98"}]}}\n\n').result.content[0].text, "99.98");
  assert.deepEqual(firstSseJson('{"result":1}'), { result: 1 }, "plain JSON also accepted");
  assert.equal(firstSseJson("garbage"), null);
});
