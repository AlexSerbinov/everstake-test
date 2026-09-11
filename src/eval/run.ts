// Runs the 20 evaluation questions, grades each with a Haiku judge, writes
// eval/results/<timestamp>.json and regenerates EVAL.md. A `human_verdict` column
// in the JSON can be edited by hand; EVAL.md prefers it when present.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ROOT, getConfig } from "../config.js";
import { ask, type AskResult } from "../ask/ask.js";
import { completeJson, loadPrompt } from "../llm.js";
import { costReport } from "./cost.js";

interface Q { id: string; type: string; question: string; reference: string; reference_source?: string; trap?: string; expect_no_answer?: boolean }
export interface EvalRow {
  id: string; type: string; trap?: string; question: string; reference: string; expect_no_answer: boolean;
  system_status: string; system_answer: string; as_of: string | null; gate: string; sources: string[];
  verdict: string; reason: string; human_verdict?: string | null;
  cost_usd: number; latency_ms: number; judge_cost_usd: number;
}
export interface EvalRun { ts: string; model: string; provider: string; rows: EvalRow[]; metrics: ReturnType<typeof metrics>; cost_summary: any }

const Verdict = z.object({ verdict: z.enum(["correct", "partially_correct", "wrong", "hallucinated", "abstained_correctly", "abstained_wrongly"]), reason: z.string() });
const RESULTS = path.join(ROOT, "eval/results");

export async function runEval(opts: { limit?: number; retryErrors?: boolean } = {}) {
  const cfg = getConfig();
  const allQs: Q[] = YAML.parse(fs.readFileSync(path.join(ROOT, "eval/questions.yaml"), "utf8")).questions;
  // --retry-errors: keep graded rows from the latest run, re-ask only the ones that hit a provider error
  const previous = opts.retryErrors ? latestEval() : null;
  const keep = previous ? previous.rows.filter((r) => !["error", "judge_error"].includes(r.human_verdict || r.verdict)) : [];
  const keptIds = new Set(keep.map((r) => r.id));
  const qs = allQs.filter((q) => !keptIds.has(q.id));
  if (previous) console.log(`retrying ${qs.length} questions, keeping ${keep.length} graded rows from ${previous.ts}`);
  const rows: EvalRow[] = [...keep];
  const judgeSystem = loadPrompt("judge");
  for (const q of qs.slice(0, opts.limit ?? qs.length)) {
    process.stdout.write(`${q.id} ${q.question.slice(0, 60)}… `);
    const r: AskResult = await ask(q.question);
    let verdict = "", reason = "", judgeCost = 0;
    if (r.gate === "model_error") { verdict = "error"; reason = r.error ?? "provider error"; }
    else try {
      const j = await completeJson({
        stage: "judge", model: cfg.models.cheap, system: judgeSystem, schema: Verdict, maxTokens: 400,
        user: `Question: ${q.question}\nReference answer: ${q.reference}\nexpect_no_answer: ${!!q.expect_no_answer}\n\nSystem status: ${r.status}\nSystem answer: ${r.answer}`,
        meta: { eval_id: q.id },
      });
      verdict = j.data.verdict; reason = j.data.reason; judgeCost = j.costUsd;
    } catch (e: any) { verdict = "judge_error"; reason = String(e?.message ?? e).slice(0, 200); }
    // deterministic overrides the judge cannot get wrong (never for provider errors)
    if (r.gate !== "model_error") {
      if (q.expect_no_answer && r.status === "no_reliable_answer") { verdict = "abstained_correctly"; }
      if (!q.expect_no_answer && r.status === "no_reliable_answer") { verdict = "abstained_wrongly"; }
    }
    rows.push({
      id: q.id, type: q.type, trap: q.trap, question: q.question, reference: q.reference, expect_no_answer: !!q.expect_no_answer,
      system_status: r.status, system_answer: r.answer, as_of: r.as_of, gate: r.gate, sources: r.sources.map((s) => s.url),
      verdict, reason, human_verdict: null, cost_usd: r.trace.cost_usd, latency_ms: r.trace.latency_ms, judge_cost_usd: judgeCost,
    });
    console.log(`→ ${r.status} / ${verdict}`);
  }
  rows.sort((a, b) => allQs.findIndex((q) => q.id === a.id) - allQs.findIndex((q) => q.id === b.id));
  const run: EvalRun = { ts: new Date().toISOString(), model: cfg.models.answer, provider: process.env.LLM_PROVIDER ?? "", rows, metrics: metrics(rows), cost_summary: costReport(true) };
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, run.ts.replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(ROOT, "EVAL.md"), renderEvalMd(run));
  console.log(`\n${JSON.stringify(run.metrics, null, 2)}\nsaved ${file} and EVAL.md`);
  return run;
}

export function metrics(rows: EvalRow[]) {
  const v = (row: EvalRow) => row.human_verdict || row.verdict;
  const count = (p: (s: string) => boolean) => rows.filter((r) => p(v(r))).length;
  const positives = rows.filter((r) => !r.expect_no_answer);
  const negatives = rows.filter((r) => r.expect_no_answer);
  const correct = count((s) => s === "correct");
  const partial = count((s) => s === "partially_correct");
  const abstainedOk = count((s) => s === "abstained_correctly");
  const errors = count((s) => s === "error" || s === "judge_error");
  const graded = Math.max(rows.length - errors, 1);
  return {
    total: rows.length,
    positive_questions: positives.length,
    negative_questions: negatives.length,
    provider_errors: errors,               // not graded: the model could not be reached
    successful: correct + abstainedOk,
    partially_correct: partial,
    failed: rows.length - errors - correct - abstainedOk - partial,
    wrong: count((s) => s === "wrong"),
    hallucinated: count((s) => s === "hallucinated"),
    abstained_correctly: abstainedOk,
    abstained_wrongly: count((s) => s === "abstained_wrongly"),
    accuracy_strict: Number(((correct + abstainedOk) / graded).toFixed(3)),
    accuracy_lenient: Number(((correct + partial + abstainedOk) / graded).toFixed(3)),
    avg_cost_per_question_usd: Number((rows.reduce((a, r) => a + r.cost_usd, 0) / rows.length).toFixed(5)),
    avg_latency_ms: Math.round(rows.reduce((a, r) => a + r.latency_ms, 0) / rows.length),
  };
}

export function latestEval(): EvalRun | null {
  if (!fs.existsSync(RESULTS)) return null;
  const files = fs.readdirSync(RESULTS).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(RESULTS, files[files.length - 1]), "utf8"));
}

export function renderEvalMd(run: EvalRun): string {
  const m = run.metrics;
  const esc = (s: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
  const lines = [
    `# EVAL — 20 questions, measured`,
    ``,
    `Run: ${run.ts} · answer model: \`${run.model}\` · provider: ${run.provider} · judge: Haiku 4.5 with deterministic overrides for abstentions.`,
    ``,
    `## Metrics`,
    ``,
    `| Metric | Value |`, `|---|---|`,
    `| Questions | ${m.total} (${m.positive_questions} positive, ${m.negative_questions} negative)${m.provider_errors ? ` — ${m.provider_errors} not graded (provider error)` : ""} |`,
    `| **Accuracy (strict)** | **${(m.accuracy_strict * 100).toFixed(0)}%** — correct + correctly abstained |`,
    `| Accuracy (lenient) | ${(m.accuracy_lenient * 100).toFixed(0)}% — also counts partially correct |`,
    `| Successful answers | ${m.successful} |`,
    `| Partially correct | ${m.partially_correct} |`,
    `| Failed | ${m.failed} (wrong ${m.wrong}, abstained wrongly ${m.abstained_wrongly}, hallucinated ${m.hallucinated}) |`,
    `| **Invented a fact (hallucinated)** | **${m.hallucinated}** |`,
    `| Abstained correctly / wrongly | ${m.abstained_correctly} / ${m.abstained_wrongly} |`,
    `| Avg cost per question | $${m.avg_cost_per_question_usd} |`,
    `| Avg latency | ${m.avg_latency_ms} ms |`,
    ``,
    `Verdicts: \`correct\`, \`partially_correct\`, \`wrong\` (a real but outdated/other value), \`hallucinated\` (unsupported, or answered a question the corpus cannot answer), \`abstained_correctly\`, \`abstained_wrongly\`. A \`human_verdict\` in the results JSON overrides the judge.`,
    ``,
    `## Table`,
    ``,
    `| # | Question | Reference Answer | System Answer | Verdict |`,
    `|---|---|---|---|---|`,
  ];
  for (const r of run.rows) {
    const v = r.human_verdict || r.verdict;
    const badge = v === "correct" || v === "abstained_correctly" ? "✅" : v === "partially_correct" ? "🟡" : "❌";
    lines.push(`| ${r.id}${r.trap ? " ⚠️" : ""} | ${esc(r.question)} | ${esc(r.reference)} | ${esc(r.system_answer)}${r.as_of ? ` _(as of ${r.as_of})_` : ""} | ${badge} ${v}${r.human_verdict ? " (human)" : ""} |`);
  }
  lines.push(``, `⚠️ = trap question (naive similarity/majority retrieval fails on it). Each system answer's sources and the retrieval trace are in \`eval/results/${run.ts.replace(/[:.]/g, "-")}.json\`.`, ``);
  lines.push(`## Honest breakdown of failures`, ``);
  const fails = run.rows.filter((r) => !["correct", "abstained_correctly"].includes(r.human_verdict || r.verdict));
  if (!fails.length) lines.push(`No failures in this run.`);
  for (const r of fails) lines.push(`- **${r.id}** (${r.human_verdict || r.verdict}, gate: ${r.gate}): ${esc(r.reason)}`);
  return lines.join("\n") + "\n";
}
