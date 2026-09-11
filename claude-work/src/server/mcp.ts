// MCP (stdio) wrapper around the same ask() core — lets Claude Desktop / Claude Code / Cursor
// call this knowledge base next to Everstake's own MCP server (which serves live APY numbers;
// this one serves dated, cited facts and history).
//
//   claude mcp add everstake-kb -- npx tsx /path/to/everstake-kb/src/server/mcp.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ask } from "../ask/ask.js";
import { factLedger } from "../index/facts.js";
import { stats } from "../ask/stats.js";

const server = new McpServer({ name: "everstake-kb", version: "0.1.0" });

server.registerTool(
  "ask_everstake",
  {
    title: "Ask the Everstake knowledge base",
    description: "Answers questions about the company Everstake from a crawled corpus of public sources (site, docs, GitHub, press, video). Every answer carries an as-of date and cited source URLs, and says 'no reliable answer' when the corpus lacks the fact. Use for facts, history and 'how did X change' questions — not for live APY/uptime numbers (use Everstake's own MCP for those).",
    inputSchema: { question: z.string().min(3).max(500) },
  },
  async ({ question }) => {
    const r = await ask(question);
    const text = [
      `${r.status === "answered" ? r.answer : "No reliable answer: " + r.answer}`,
      r.as_of ? `As of: ${r.as_of}` : "",
      r.sources.length ? "Sources:\n" + r.sources.map((s) => `[${s.n}] ${s.title} — ${s.url}${s.published_at ? ` (${s.published_at})` : ""}`).join("\n") : "",
      `Confidence: ${r.confidence}  ·  mode: ${r.mode ?? "n/a"}  ·  cost: $${r.trace.cost_usd.toFixed(4)}`,
    ].filter(Boolean).join("\n\n");
    return { content: [{ type: "text", text }], structuredContent: { status: r.status, answer: r.answer, as_of: r.as_of, confidence: r.confidence, sources: r.sources } };
  },
);

server.registerTool(
  "everstake_fact_history",
  {
    title: "Fact ledger / history",
    description: "Returns every recorded value of a fact key over time with source URLs (e.g. networks_supported, delegators, ceo, certifications). Useful to see how a number changed across years.",
    inputSchema: { key: z.string().describe("one of: networks_supported, delegators, total_staked_usd, rewards_generated_usd, uptime, validators, ceo, president, founder, ccdo, founded_year, legal_entity, headquarters, certifications, auditor, products, team_size, mcp_endpoint, slashing_events, partners, custody_model") },
  },
  async ({ key }) => {
    const rows = factLedger(key).slice(0, 40);
    return { content: [{ type: "text", text: rows.length ? rows.map((r: any) => `${r.as_of ?? "undated"}  ${r.value}  (tier ${r.tier}) ${r.url}`).join("\n") : "no facts recorded for this key" }], structuredContent: { key, rows } };
  },
);

server.registerTool(
  "everstake_kb_stats",
  { title: "Corpus statistics", description: "Corpus size, duplicates found, AI-directed instructions found, measured costs.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(stats(), null, 2) }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
