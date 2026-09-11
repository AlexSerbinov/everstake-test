// Haiku reads every canonical document once and fills the fact ledger:
// (key, value, as_of, quote, source). This gives factual lookups a structured,
// date-stamped answer path and gives synthesis questions a ready-made timeline.

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

const ALLOWED = new Set("networks_supported,delegators,total_staked_usd,rewards_generated_usd,uptime,validators,ceo,president,founder,ccdo,founded_year,legal_entity,headquarters,certifications,auditor,products,team_size,mcp_endpoint,slashing_events,partners,custody_model".split(","));

export async function extractFacts(opts: { force?: boolean; limit?: number; urlLike?: string }) {
  const cfg = getConfig();
  const docs = all<{ id: number; url: string; title: string; text: string; published_at: string | null; fetched_at: string; category: string; n: number }>(
    `SELECT d.id, d.url, d.title, d.text, d.published_at, d.fetched_at, d.category, (SELECT COUNT(*) FROM facts f WHERE f.doc_id = d.id) n
     FROM documents d WHERE d.status='ok' AND d.duplicate_of IS NULL ORDER BY d.tier, d.id`);
  const todo = docs.filter((d) => (opts.force || d.n === 0) && (!opts.urlLike || d.url.includes(opts.urlLike))).slice(0, opts.limit ?? Infinity);
  console.log(`extracting facts from ${todo.length} documents with ${cfg.models.cheap}…`);
  const system = loadPrompt("extract_facts");
  let total = 0, cost = 0;
  // small concurrency: 4 documents in flight
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift()!;
      try {
        const r = await completeJson({
          stage: "facts", model: cfg.models.cheap, system, schema: FactSchema, maxTokens: 2000, cacheSystem: true,
          user: `Document URL: ${d.url}\nTitle: ${d.title}\nPublished: ${d.published_at ?? "unknown"}\n\n<document>\n${d.text.slice(0, 24000)}\n</document>`,
          meta: { doc_id: d.id },
        });
        cost += r.costUsd;
        transaction(() => {
          run("DELETE FROM facts WHERE doc_id = ?", d.id);
          for (const f of r.data.facts) {
            if (!ALLOWED.has(f.key)) continue;
            const flags = new Set(f.flags);
            if (malformedNumbers(f.value).length || malformedNumbers(f.quote).length) flags.add("malformed_number");
            // as_of priority: explicit date in the text → document publication date → for evergreen
            // site/docs pages, the fetch date (a live page states the present)
            const explicit = f.as_of && /^\d{4}-\d{2}-\d{2}$/.test(f.as_of);
            const live = !d.published_at && ["site", "docs", "code"].includes(d.category);
            const asOf = explicit ? f.as_of : d.published_at ?? (live ? d.fetched_at.slice(0, 10) : null);
            const asOfSource = explicit ? "text" : d.published_at ? "document" : live ? "live-page" : null;
            run("INSERT INTO facts (doc_id, key, value, as_of, as_of_source, quote, confidence, flags) VALUES (?,?,?,?,?,?,?,?)",
              d.id, f.key, f.value.trim(), asOf, asOfSource, f.quote.slice(0, 400), f.confidence, flags.size ? [...flags].join(",") : null);
            total++;
          }
        });
        process.stdout.write(`  doc ${d.id} → ${r.data.facts.length} facts  (running cost $${cost.toFixed(3)})\r`);
      } catch (e: any) {
        console.warn(`\n  doc ${d.id} failed: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const removed = cleanFacts();
  console.log(`\nfacts done: ${total} facts extracted, ${removed} removed by hygiene rules, $${cost.toFixed(4)}`);
}

const PERSON_KEYS = ["ceo", "president", "founder", "ccdo"];
const NUMERIC_KEYS = ["networks_supported", "delegators", "total_staked_usd", "rewards_generated_usd", "uptime", "validators", "team_size", "founded_year"];

/**
 * Cheap, deterministic hygiene after the model:
 *  - a leadership fact must be about Everstake (blog posts quote CEOs of other companies);
 *  - a numeric key must carry a number (the model sometimes lists network *names* under networks_supported).
 * Runs in SQL so it can be re-applied without paying for extraction again.
 */
export function cleanFacts(): number {
  const q = (keys: string[]) => keys.map(() => "?").join(",");
  // Other companies' executives show up in blog posts and third-party pages; on Everstake's own
  // non-blog pages (about, careers, press) a bare "Sergii Vasylchuk — CEO" is about Everstake.
  const a = run(`DELETE FROM facts WHERE key IN (${q(PERSON_KEYS)}) AND lower(quote) NOT LIKE '%everstake%'
                 AND doc_id IN (SELECT id FROM documents WHERE tier > 1 OR url LIKE '%/resources/blog/%' OR category = 'video')`, ...PERSON_KEYS).changes;
  const b = run(`DELETE FROM facts WHERE key IN (${q(NUMERIC_KEYS)}) AND value NOT GLOB '*[0-9]*'`, ...NUMERIC_KEYS).changes;
  return Number(a) + Number(b);
}

export function factLedger(key?: string) {
  return all(
    `SELECT f.id, f.key, f.value, f.as_of, f.as_of_source, f.quote, f.confidence, f.flags, d.id doc_id, d.url, d.title, d.tier, d.domain, d.ai_directed
     FROM facts f JOIN documents d ON d.id = f.doc_id
     WHERE d.status='ok' AND d.duplicate_of IS NULL ${key ? "AND f.key = ?" : ""}
     ORDER BY f.key, f.as_of DESC, d.tier`, ...(key ? [key] : []));
}
