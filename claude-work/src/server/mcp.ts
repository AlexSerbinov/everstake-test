// MCP (stdio) wrapper around the same ask() core — lets Claude Desktop / Claude Code / Cursor
// call this knowledge base next to Everstake's own MCP server (which serves live APY and
// uptime numbers; this one serves dated, cited facts and history).
//
//   claude mcp add everstake-kb -- npx tsx /path/to/everstake-kb/src/server/mcp.ts
//
// WHY ONLY THREE TOOLS. The surface is deliberately small, and each tool earns its place by
// answering a question the others cannot:
//   ask_everstake         — the whole pipeline behind one call. This is the product.
//   everstake_fact_history— the one thing a natural-language answer cannot give you: every
//                           recorded value of a key over time, so a caller can see a number
//                           change rather than get today's value. Reads the fact ledger
//                           directly, no model involved, so it is free and instant.
//   everstake_kb_stats    — provenance for the other two: how big the corpus is, how many
//                           duplicates and AI-directed instructions were found, what it cost.
//                           Without it a caller has no way to judge how much to trust an answer.
// Nothing that writes, nothing that crawls, nothing that exposes raw SQL. A calling model
// picks tools from their descriptions, so every extra tool is another chance to pick wrong —
// and every tool that mutates state is another thing a prompt injection could aim at.
//
// This uses ask() (single retrieval → single prompt), not answerQuestion() (the agent loop):
// an MCP client is usually itself an agent, so paying for a second nested tool loop inside
// this one would duplicate work the caller is already doing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ask } from "../ask/ask.js";
import { factLedger } from "../index/facts.js";
import { stats } from "../ask/stats.js";

/** Same bounds as the HTTP endpoint: too short to be a real question, too long to be one either. */
const MIN_QUESTION_CHARS = 3;
const MAX_QUESTION_CHARS = 500;

/** A fact key can have many recorded values; enough to show a trend without flooding the caller. */
const MAX_FACT_HISTORY_ROWS = 40;

const server = new McpServer({ name: "everstake-kb", version: "0.1.0" });

server.registerTool(
  "ask_everstake",
  {
    title: "Ask the Everstake knowledge base",
    // The description is the routing logic: a calling model reads this to decide whether to
    // use this tool or Everstake's live-metrics MCP, so it says explicitly what NOT to use it for.
    description: "Answers questions about the company Everstake from a crawled corpus of public sources (site, docs, GitHub, press, video). Every answer carries an as-of date and cited source URLs, and says 'no reliable answer' when the corpus lacks the fact. Use for facts, history and 'how did X change' questions — not for live APY/uptime numbers (use Everstake's own MCP for those).",
    inputSchema: { question: z.string().min(MIN_QUESTION_CHARS).max(MAX_QUESTION_CHARS) },
  },
  async ({ question }) => {
    const result = await ask(question);
    // Two representations of the same answer: `text` for a model reading prose, and
    // `structuredContent` for a client that wants the fields. They must not disagree.
    const headline = result.status === "answered"
      ? result.answer
      : `No reliable answer: ${result.answer}`;
    const sourceList = result.sources
      .map((source) => `[${source.n}] ${source.title} — ${source.url}${source.published_at ? ` (${source.published_at})` : ""}`)
      .join("\n");
    const text = [
      headline,
      result.as_of ? `As of: ${result.as_of}` : "",
      result.sources.length ? `Sources:\n${sourceList}` : "",
      `Confidence: ${result.confidence}  ·  mode: ${result.mode ?? "n/a"}  ·  cost: $${result.trace.cost_usd.toFixed(4)}`,
    ].filter(Boolean).join("\n\n");   // drop the empty as-of / sources lines rather than print blanks
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        status: result.status,
        answer: result.answer,
        as_of: result.as_of,
        confidence: result.confidence,
        sources: result.sources,
      },
    };
  },
);

server.registerTool(
  "everstake_fact_history",
  {
    title: "Fact ledger / history",
    description: "Returns every recorded value of a fact key over time with source URLs (e.g. networks_supported, delegators, ceo, certifications). Useful to see how a number changed across years.",
    // The keys are enumerated in the description because MCP clients show it to the model as
    // free text: without the list, a caller guesses key names and gets empty results.
    inputSchema: { key: z.string().describe("one of: networks_supported, delegators, total_staked_usd, rewards_generated_usd, uptime, validators, ceo, president, founder, ccdo, founded_year, legal_entity, headquarters, certifications, auditor, products, team_size, mcp_endpoint, slashing_events, partners, custody_model") },
  },
  async ({ key }) => {
    const rows = factLedger(key).slice(0, MAX_FACT_HISTORY_ROWS);
    // Tier is included so the caller can weigh a company page against a third-party article.
    const text = rows.length
      ? rows.map((row: any) => `${row.as_of ?? "undated"}  ${row.value}  (tier ${row.tier}) ${row.url}`).join("\n")
      : "no facts recorded for this key";
    return { content: [{ type: "text", text }], structuredContent: { key, rows } };
  },
);

server.registerTool(
  "everstake_kb_stats",
  {
    title: "Corpus statistics",
    description: "Corpus size, duplicates found, AI-directed instructions found, measured costs.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: JSON.stringify(stats(), null, 2) }] }),
);

// stdio, not HTTP: the client launches this process and owns its lifetime, so there is no port
// to expose and no authentication to get wrong.
const transport = new StdioServerTransport();
await server.connect(transport);
