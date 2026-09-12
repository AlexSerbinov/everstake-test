// The main evaluation: ask the 20 questions in eval/questions.yaml, grade every answer,
// write eval/results/<ISO timestamp>.json and regenerate EVAL.md.
//
// This is the file the "measurable results" requirement rests on. If its grading is wrong,
// every accuracy number in REPORT.md is wrong, so the grading is deliberately layered:
//
//   1. A cheap judge model compares the system answer against a hand-written reference and
//      returns one of six verdicts. A judge is used here — unlike in the adversarial suite —
//      because "does this paragraph say the same thing as the reference" is a language
//      question, not a security question, and there is no attacker trying to fool it.
//   2. Deterministic overrides are then applied ON TOP of the judge for the one thing code
//      can decide better than a model: whether an abstention was the right call. That is a
//      comparison of two booleans (`expect_no_answer` vs `status`), so leaving it to a model
//      would only add noise. See `applyAbstentionOverrides`.
//   3. `human_verdict` in the results JSON, added by hand after reading a run, overrides
//      everything. Nothing in the code writes it — freshly asked rows always store `null`.
//      It exists so a judge mistake can be corrected without re-paying for the whole run,
//      and every override is listed by name in EVAL.md so the correction is not silent.
//
// THE VERDICT VOCABULARY (the enum below is the single source of truth):
//   correct              — matches the reference.
//   partially_correct    — true and relevant but incomplete, or missing a qualifier.
//   wrong                — a real value, but the wrong one (usually an outdated figure).
//   hallucinated         — unsupported by any source, or an answer to a question the corpus
//                          cannot answer. Counted separately because it is the failure mode
//                          that matters most for a knowledge base.
//   abstained_correctly  — refused, and refusing was right (`expect_no_answer: true`).
//   abstained_wrongly    — refused, but the corpus did contain the answer. Over-caution.
// Strict accuracy counts only `correct` + `abstained_correctly`. Lenient additionally counts
// `partially_correct`. Both are reported, so neither can be quoted without the other.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ROOT, getConfig } from "../config.js";
import { ask, type AskResult } from "../ask/ask.js";
import { answerQuestion } from "../ask/agent.js";
import { completeJson, loadPrompt } from "../llm.js";
import { costReport } from "./cost.js";

/** One row of eval/questions.yaml. `trap` names why naive retrieval is expected to fail on it. */
interface Question {
  id: string;
  type: string;
  question: string;
  reference: string;
  reference_source?: string;
  trap?: string;
  /** The corpus genuinely cannot answer this; refusing is the correct behaviour. */
  expect_no_answer?: boolean;
}

export interface EvalRow {
  id: string;
  type: string;
  trap?: string;
  question: string;
  reference: string;
  expect_no_answer: boolean;
  system_status: string;
  system_answer: string;
  as_of: string | null;
  gate: string;
  sources: string[];
  verdict: string;
  reason: string;
  /** Hand-edited in the JSON after a run; overrides `verdict` everywhere it is read. */
  human_verdict?: string | null;
  /** Hand-written after reading the run. Rendered in EVAL.md next to the judge's reason. */
  analysis?: string | null;
  cost_usd: number;
  latency_ms: number;
  judge_cost_usd: number;
}

export type Engine = "agent" | "single";

export interface EvalRun {
  ts: string;
  engine: Engine;
  model: string;
  resolved_model?: string | null;
  judge_model?: string | null;
  provider: string;
  rows: EvalRow[];
  metrics: ReturnType<typeof metrics>;
  cost_summary: any;
}

/** The judge's only permitted outputs. A model that returns anything else fails schema parsing. */
const Verdict = z.object({
  verdict: z.enum([
    "correct",
    "partially_correct",
    "wrong",
    "hallucinated",
    "abstained_correctly",
    "abstained_wrongly",
  ]),
  reason: z.string(),
});

const RESULTS = path.join(ROOT, "eval/results");

/** A verdict plus a one-sentence justification fits comfortably; the cap is a cost guard. */
const JUDGE_MAX_TOKENS = 400;

/** Verdicts that mean the model could not be reached, so the row was never really graded. */
const NOT_GRADED = ["error", "judge_error"];

function loadQuestions(): Question[] {
  return YAML.parse(fs.readFileSync(path.join(ROOT, "eval/questions.yaml"), "utf8")).questions;
}

/**
 * Rows carried over from the previous run instead of being re-asked, for the two flags that
 * exist to avoid paying for a full run twice:
 *   --retry-errors  keep every graded row, re-ask only the ones that hit a provider error;
 *   --only=q01,q15  keep everything except the listed ids.
 * Returns [] when neither flag is set, so a normal run asks all 20.
 */
function rowsToKeep(previous: EvalRun | null, only?: string[]): EvalRow[] {
  if (!previous) return [];
  if (only) return previous.rows.filter((row) => !only.includes(row.id));
  return previous.rows.filter((row) => !NOT_GRADED.includes(row.human_verdict || row.verdict));
}

/**
 * Grades one answer against its reference with the cheap model. Returns a `judge_error`
 * verdict rather than throwing: one unparseable judge response must not lose the other 19
 * rows, and the failure has to be visible in the results file instead of swallowed.
 */
async function judgeAnswer(
  question: Question,
  result: AskResult,
  judgeSystem: string,
  judgeModel: string,
): Promise<{ verdict: string; reason: string; costUsd: number; model: string | null }> {
  try {
    const judged = await completeJson({
      stage: "judge",
      model: judgeModel,
      system: judgeSystem,
      schema: Verdict,
      maxTokens: JUDGE_MAX_TOKENS,
      user: `Question: ${question.question}\nReference answer: ${question.reference}\nexpect_no_answer: ${!!question.expect_no_answer}\n\nSystem status: ${result.status}\nSystem answer: ${result.answer}`,
      meta: { eval_id: question.id },
    });
    return {
      verdict: judged.data.verdict,
      reason: judged.data.reason,
      costUsd: judged.costUsd,
      model: judged.model ?? null,
    };
  } catch (e: any) {
    return { verdict: "judge_error", reason: String(e?.message ?? e).slice(0, 200), costUsd: 0, model: null };
  }
}

/**
 * Replaces the judge's verdict whenever the system refused to answer. Whether a refusal was
 * right is decided by `expect_no_answer` in the question file, which is a fact about the
 * corpus, not a matter of opinion — so a model must not be allowed to disagree with it.
 *
 * Skipped for provider errors: a row that never got an answer has nothing to grade, and
 * overriding it would launder an outage into an "abstained_wrongly".
 */
function applyAbstentionOverrides(question: Question, result: AskResult, judgeVerdict: string): string {
  if (result.gate === "model_error") return judgeVerdict;
  if (result.status !== "no_reliable_answer") return judgeVerdict;
  return question.expect_no_answer ? "abstained_correctly" : "abstained_wrongly";
}

export async function runEval(
  opts: { limit?: number; retryErrors?: boolean; only?: string[]; engine?: Engine } = {},
) {
  // Default: the agent (tool loop). --engine=single re-runs the original one-retrieval-one-prompt
  // path, which is kept so the report can compare the two on the same questions.
  const engine: Engine = opts.engine ?? "agent";
  const config = getConfig();
  const allQuestions = loadQuestions();

  const previous = opts.retryErrors || opts.only ? latestEval() : null;
  const keep = rowsToKeep(previous, opts.only);
  const keptIds = new Set(keep.map((row) => row.id));
  const toAsk = allQuestions.filter((question) => !keptIds.has(question.id));
  if (previous) console.log(`retrying ${toAsk.length} questions, keeping ${keep.length} graded rows from ${previous.ts}`);
  console.log(`engine: ${engine}`);

  const rows: EvalRow[] = [...keep];
  let lastResolvedModel: string | null = null;
  let lastJudgeModel: string | null = null;
  const judgeSystem = loadPrompt("judge");

  for (const question of toAsk.slice(0, opts.limit ?? toAsk.length)) {
    process.stdout.write(`${question.id} ${question.question.slice(0, 60)}… `);
    const result: AskResult = engine === "single"
      ? await ask(question.question)
      : await answerQuestion(question.question);
    // config says e.g. "claude-opus-5"; the provider may serve something else. Record the truth.
    lastResolvedModel = result.trace.model ?? lastResolvedModel;

    let verdict = "";
    let reason = "";
    let judgeCost = 0;
    if (result.gate === "model_error") {
      // The provider never answered, so there is nothing for the judge to read — and paying
      // it to grade an empty string would corrupt both the accuracy and the cost numbers.
      verdict = "error";
      reason = result.error ?? "provider error";
    } else {
      const judged = await judgeAnswer(question, result, judgeSystem, config.models.cheap);
      verdict = judged.verdict;
      reason = judged.reason;
      judgeCost = judged.costUsd;
      lastJudgeModel = judged.model ?? lastJudgeModel;
    }
    verdict = applyAbstentionOverrides(question, result, verdict);

    rows.push({
      id: question.id,
      type: question.type,
      trap: question.trap,
      question: question.question,
      reference: question.reference,
      expect_no_answer: !!question.expect_no_answer,
      system_status: result.status,
      system_answer: result.answer,
      as_of: result.as_of,
      gate: result.gate,
      sources: [...new Set(result.sources.map((source) => source.url))],   // pages, not passages
      verdict,
      reason,
      human_verdict: null,   // only ever set by hand, in the results JSON
      cost_usd: result.trace.cost_usd,
      latency_ms: result.trace.latency_ms,
      judge_cost_usd: judgeCost,
    });
    console.log(`→ ${result.status} / ${verdict}`);
  }

  // Kept rows were appended before the re-asked ones; restore question-file order so two runs
  // are diffable line by line.
  rows.sort((a, b) =>
    allQuestions.findIndex((q) => q.id === a.id) - allQuestions.findIndex((q) => q.id === b.id));

  const run: EvalRun = {
    ts: new Date().toISOString(),
    engine,
    model: config.models.answer,
    resolved_model: lastResolvedModel,
    judge_model: lastJudgeModel,
    provider: process.env.LLM_PROVIDER ?? "",
    rows,
    metrics: metrics(rows),
    cost_summary: costReport(true),
  };
  fs.mkdirSync(RESULTS, { recursive: true });
  // Colons and dots are illegal or awkward in filenames, so the ISO timestamp is flattened.
  const file = path.join(RESULTS, run.ts.replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(ROOT, "EVAL.md"), renderEvalMd(run));
  console.log(`\n${JSON.stringify(run.metrics, null, 2)}\nsaved ${file} and EVAL.md`);
  return run;
}

/**
 * The headline numbers. Every count reads `human_verdict || verdict`, so a hand-corrected row
 * is counted as corrected — see the note on `renderEvalMd` about when this must be recomputed.
 *
 * Provider errors are excluded from the denominator (`graded`) rather than counted as
 * failures: an unreachable model is an outage, not a wrong answer, and folding it into the
 * accuracy would make the system look worse for a reason that has nothing to do with it.
 * They are reported separately as `provider_errors` so the exclusion is visible.
 */
export function metrics(rows: EvalRow[]) {
  const verdictOf = (row: EvalRow) => row.human_verdict || row.verdict;
  const count = (matches: (verdict: string) => boolean) =>
    rows.filter((row) => matches(verdictOf(row))).length;

  const positives = rows.filter((row) => !row.expect_no_answer);
  const negatives = rows.filter((row) => row.expect_no_answer);
  const correct = count((v) => v === "correct");
  const partial = count((v) => v === "partially_correct");
  const abstainedOk = count((v) => v === "abstained_correctly");
  const errors = count((v) => NOT_GRADED.includes(v));
  // max(…, 1) only guards division by zero on an all-errors run; with any graded row it is a no-op.
  const graded = Math.max(rows.length - errors, 1);

  return {
    total: rows.length,
    positive_questions: positives.length,
    negative_questions: negatives.length,
    provider_errors: errors,               // not graded: the model could not be reached
    successful: correct + abstainedOk,
    partially_correct: partial,
    failed: rows.length - errors - correct - abstainedOk - partial,
    wrong: count((v) => v === "wrong"),
    hallucinated: count((v) => v === "hallucinated"),
    abstained_correctly: abstainedOk,
    abstained_wrongly: count((v) => v === "abstained_wrongly"),
    accuracy_strict: Number(((correct + abstainedOk) / graded).toFixed(3)),
    accuracy_lenient: Number(((correct + partial + abstainedOk) / graded).toFixed(3)),
    avg_cost_per_question_usd:
      Number((rows.reduce((sum, row) => sum + row.cost_usd, 0) / rows.length).toFixed(5)),
    avg_latency_ms: Math.round(rows.reduce((sum, row) => sum + row.latency_ms, 0) / rows.length),
  };
}

/** Path of the newest stored eval run, or null when none exists.
 *  `adversarial-*.json` lives in the same folder and is a different shape — never pick it up.
 *  ISO timestamps sort lexicographically, so plain `.sort()` gives chronological order. */
export function latestEvalPath(): string | null {
  if (!fs.existsSync(RESULTS)) return null;
  const files = fs.readdirSync(RESULTS)
    .filter((name) => name.endsWith(".json") && !name.startsWith("adversarial-"))
    .sort();
  if (!files.length) return null;
  return path.join(RESULTS, files[files.length - 1]);
}

export function latestEval(): EvalRun | null {
  const file = latestEvalPath();
  return file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Write a run back over the file it was loaded from.
 *
 *  Why this exists: `metrics()` reads `human_verdict || verdict`, but nothing in the pipeline
 *  ever *writes* a `human_verdict` — a person edits one into the results JSON by hand. Before
 *  this, `--render` recomputed the metrics in memory, wrote EVAL.md and threw the recomputed
 *  block away, so the JSON kept the pre-override numbers forever. That matters because
 *  `GET /api/eval` serves the JSON: the live demo showed strict 75% while EVAL.md and
 *  REPORT.md said 80%, and a reviewer comparing the two would see the system contradict its
 *  own report. Rewriting the file keeps every reader of the run on the same numbers. */
export function saveEvalRun(run: EvalRun): void {
  const file = latestEvalPath();
  if (!file) throw new Error("no eval results file to write back to");
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
}

/** Escapes text for one markdown table cell: pipes would end the cell, newlines the row. */
const escapeCell = (text: string) => (text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

/** The verdict actually used for reporting — the hand correction if there is one. */
const effectiveVerdict = (row: EvalRow) => row.human_verdict || row.verdict;

/** Provenance line: which engine, which model actually served, which judge graded. */
function renderRunHeader(run: EvalRun): string[] {
  const engineNote = run.engine === "agent"
    ? " (tool loop, src/ask/agent.ts)"
    : " (one retrieval → one prompt)";
  const modelNote = run.resolved_model && run.resolved_model !== run.model
    ? ` (config key \`${run.model}\`)`
    : "";
  return [
    `# EVAL — 20 questions, measured`,
    ``,
    `Run: ${run.ts} · engine: \`${run.engine ?? "single"}\`${engineNote} · answer model: \`${run.resolved_model ?? run.model}\`${modelNote} · provider: ${run.provider} · judge: \`${run.judge_model ?? "haiku-4.5"}\` with deterministic overrides for abstentions.`,
  ];
}

/** The metrics table, read straight from `run.metrics` — this function never recomputes. */
function renderMetricsTable(m: EvalRun["metrics"]): string[] {
  const notGradedNote = m.provider_errors
    ? ` — ${m.provider_errors} not graded (provider error)`
    : "";
  return [
    `## Metrics`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Questions | ${m.total} (${m.positive_questions} positive, ${m.negative_questions} negative)${notGradedNote} |`,
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
  ];
}

/** One line per question: what was asked, the reference, what came back, the verdict. */
function renderQuestionTable(run: EvalRun): string[] {
  const lines = [
    `## Table`,
    ``,
    `| # | Question | Reference Answer | System Answer | Verdict |`,
    `|---|---|---|---|---|`,
  ];
  for (const row of run.rows) {
    const verdict = effectiveVerdict(row);
    const badge = verdict === "correct" || verdict === "abstained_correctly"
      ? "✅"
      : verdict === "partially_correct" ? "🟡" : "❌";
    const asOf = row.as_of ? ` _(as of ${row.as_of})_` : "";
    const humanTag = row.human_verdict ? " (human)" : "";
    lines.push(
      `| ${row.id}${row.trap ? " ⚠️" : ""} | ${escapeCell(row.question)} | ${escapeCell(row.reference)} | ` +
      `${escapeCell(row.system_answer)}${asOf} | ${badge} ${verdict}${humanTag} |`,
    );
  }
  lines.push(
    ``,
    `⚠️ = trap question (naive similarity/majority retrieval fails on it). Each system answer's sources and the retrieval trace are in \`eval/results/${run.ts.replace(/[:.]/g, "-")}.json\`.`,
    ``,
  );
  return lines;
}

/**
 * Every non-success spelled out by id, plus the list of judge verdicts corrected by hand.
 * Both sections are the honesty requirement of the assignment: a report that only prints an
 * accuracy percentage is not a measurement anyone can check, and a hand override that is not
 * declared is indistinguishable from cooking the number.
 */
function renderFailures(run: EvalRun): string[] {
  const lines = [`## Honest breakdown of failures`, ``];
  const failures = run.rows.filter(
    (row) => !["correct", "abstained_correctly"].includes(effectiveVerdict(row)));
  if (!failures.length) lines.push(`No failures in this run.`);
  for (const row of failures) {
    const byHand = row.analysis ? `\n  - _Looked at by hand:_ ${escapeCell(row.analysis)}` : "";
    lines.push(`- **${row.id}** (${effectiveVerdict(row)}, gate: ${row.gate}): ${escapeCell(row.reason)}${byHand}`);
  }

  const overridden = run.rows.filter((row) => row.human_verdict && row.human_verdict !== row.verdict);
  if (overridden.length) {
    lines.push(``, `### Judge verdicts overridden by hand`, ``);
    for (const row of overridden) {
      lines.push(`- **${row.id}**: judge said \`${row.verdict}\`, recorded as \`${row.human_verdict}\`. ${escapeCell(row.analysis ?? "")}`);
    }
  }
  return lines;
}

/**
 * Renders EVAL.md from a run.
 *
 * Note the asymmetry, because it matters: the metrics table is printed from the stored
 * `run.metrics`, while the per-question table and the failure list recompute
 * `human_verdict || verdict` from the rows on every render. A caller that hand-edits a
 * `human_verdict` must therefore recompute `run.metrics` before rendering — `cli.ts --render`
 * does exactly that. See the note in the final report about the stale `metrics` block that
 * this asymmetry leaves behind in the results JSON.
 */
export function renderEvalMd(run: EvalRun): string {
  const lines = [
    ...renderRunHeader(run),
    ``,
    ...renderMetricsTable(run.metrics),
    ``,
    ...renderQuestionTable(run),
    ...renderFailures(run),
  ];
  return lines.join("\n") + "\n";
}
