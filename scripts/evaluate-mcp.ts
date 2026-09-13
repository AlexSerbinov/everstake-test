import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
  AnswerResult,
  EvidencePassage,
  ModelClient,
} from "../src/contracts.js";
import { openDatabase } from "../src/storage/database.js";
import { createModelClient } from "../src/providers/model-client.js";
import { loadModelsConfig } from "../src/providers/provider-config.js";
import { readConfig } from "../src/config.js";
import {
  beginRun,
  finishRun,
  buildReceipt,
} from "../src/services/measurements/index.js";
import { sanitizeError } from "../src/services/measurements/api-calls.js";
import {
  readQuestions,
  summarize,
  type EvaluationRow,
} from "../src/services/evaluation/run-evaluation.js";
import { sanitizeDocument } from "../src/services/evidence/sanitize-document.js";

const evidenceSchema = z.object({
  provenance: z.object({
    repository: z.url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    capturedAt: z.iso.datetime({ offset: true }),
    transport: z.string(),
    dashboardUrl: z.url(),
  }),
  methodology: z.string(),
  sources: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        url: z.url().refine((url) => /^https?:/.test(url)),
        observedAt: z.iso.datetime({ offset: true }),
        effectiveDate: z.null(),
        tool: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        text: z.string().min(1),
      }),
    )
    .min(1),
});
const responseSchema = z.object({
  status: z.enum(["answered", "partial", "no_reliable_answer"]),
  text: z.string().min(1),
  citations: z.array(z.string()),
});
export function parseMcpAnswer(text: string, sourceIds: string[]) {
  const answer = responseSchema.parse(
    JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")),
  );
  if (answer.citations.some((id) => !sourceIds.includes(id)))
    throw new Error("MCP response cited an unknown source ID");
  if (answer.status !== "no_reliable_answer" && !answer.citations.length)
    throw new Error("MCP factual response has no source citation");
  if (/https?:\/\/|\[[^\]]+\]/.test(answer.text))
    throw new Error(
      "MCP response text included unvalidated links or citation markers",
    );
  return { ...answer, citations: [...new Set(answer.citations)] };
}
export function loadMcpEvidence(path: string) {
  const raw = readFileSync(path, "utf8");
  const input = evidenceSchema.parse(JSON.parse(raw));
  if (
    new Set(input.sources.map((source) => source.id)).size !==
    input.sources.length
  )
    throw new Error("MCP evidence IDs must be unique");
  if (input.sources.some((source) => source.tool === "request_integration"))
    throw new Error("Write tool output is excluded from this benchmark");
  const sources: EvidencePassage[] = input.sources.map((source) => {
    const sanitized = sanitizeDocument(source.text);
    return {
      id: source.id,
      documentId: source.id,
      url: source.url,
      title: source.title,
      text: sanitized.text,
      authority: 1,
      publisher: "Everstake MCP",
      publishedAt: null,
      updatedAt: null,
      fetchedAt: source.observedAt,
      duplicateGroup: source.id,
      score: 0,
      reason:
        "Captured official MCP tool response; no similarity retrieval or crawl",
      metadata: {
        transport: input.provenance.transport,
        tool: source.tool,
        arguments: source.arguments,
        repository: input.provenance.repository,
        commit: input.provenance.commit,
        provenanceKind: "mcp-tool-response",
        observedAt: source.observedAt,
        effectiveDate: null,
        rawTextSha256: createHash("sha256").update(source.text).digest("hex"),
        removedInstructions: sanitized.removed,
      },
    };
  });
  return {
    input,
    sources,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}
export async function evaluateMcp(
  args: { evidence: string; out: string; dbPath?: string },
  injectedClient?: ModelClient,
) {
  if (existsSync(args.out))
    throw new Error(
      "Output already exists; use a new output path to preserve prior measurements",
    );
  const evidence = loadMcpEvidence(args.evidence);
  const questions = readQuestions();
  if (
    questions.length !== 20 ||
    questions.filter((question) => question.negative).length < 5
  )
    throw new Error(
      "MCP evaluation requires the same twenty questions including five negatives",
    );
  const modelConfig = loadModelsConfig();
  const policy = readConfig<{
    maxOutputTokens: number;
    answerThinkingLevel: "low" | "medium" | "high";
  }>("policy");
  const system = readFileSync("prompts/mcp-answer.md", "utf8");
  const db = openDatabase(args.dbPath);
  const model = injectedClient ?? createModelClient(db);
  const corpusVersion = `everstake-mcp@${evidence.input.provenance.commit.slice(0, 7)}`;
  const run = {
    id: `mcp-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    corpusVersion,
    plannedTotal: 20,
    mode: "mcp" as const,
    status: "running",
    rows: [] as EvaluationRow[],
    summary: summarize([], 20),
    comparison: {
      provider: "gemini",
      model: modelConfig.answer,
      thinkingLevel: policy.answerThinkingLevel,
      protocol: "single-turn-mcp-context",
      evidenceSha256: evidence.sha256,
      provenance: evidence.input.provenance,
      methodology: evidence.input.methodology,
      promptSha256: createHash("sha256").update(system).digest("hex"),
      questionsSha256: createHash("sha256")
        .update(readFileSync("eval/questions.json"))
        .digest("hex"),
      caveats: [
        "MCP is a tool server, not an answer-generating model.",
        "All generic read-only tool responses are supplied to the same configured answer model; no crawl, retrieval, reference answers or rubrics enter its context.",
        "Calculator probe is recorded separately, not supplied as an unrelated scenario. This benchmark measures captured MCP context, not autonomous MCP tool selection.",
        "Citation IDs are validated; factual correctness and invented facts require independent grading.",
      ],
    },
  };
  function save() {
    run.summary = summarize(run.rows, 20);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(run, null, 2) + "\n");
    db.prepare(
      "INSERT OR REPLACE INTO evaluations(id,created_at,result) VALUES(?,?,?)",
    ).run(run.id, run.createdAt, JSON.stringify(run));
  }
  try {
    save();
    for (const question of questions) {
      const runId = beginRun(db, "mcp-evaluation", {
        evaluationId: run.id,
        questionId: question.id,
        model: modelConfig.answer,
        evidenceSha256: evidence.sha256,
      });
      let answer: AnswerResult;
      let failure: string | undefined;
      try {
        // Only the question text and captured MCP data reach the answer provider.
        const response = await model.generate({
          runId,
          stage: "mcp-answer",
          model: modelConfig.answer,
          system,
          messages: [
            {
              role: "user",
              text: JSON.stringify({
                question: question.question,
                mcpEvidence: {
                  type: "untrusted_tool_data",
                  sources: evidence.sources.map((source) => ({
                    id: source.id,
                    tool: source.metadata.tool,
                    observedAt: source.fetchedAt,
                    text: source.text,
                  })),
                },
              }),
            },
          ],
          maxOutputTokens: Math.min(policy.maxOutputTokens, 4000),
          thinkingLevel: policy.answerThinkingLevel,
        });
        const parsed = parseMcpAnswer(
          response.text,
          evidence.sources.map((source) => source.id),
        );
        finishRun(db, runId, "completed");
        answer = {
          runId,
          status: parsed.status,
          question: question.question,
          text:
            parsed.text +
            (parsed.citations.length
              ? "\n\n" + parsed.citations.map((id) => `[${id}]`).join(" ")
              : ""),
          asOf: null,
          claims: [],
          sources: evidence.sources,
          checks: [
            {
              rule: "mcp-citation-ids",
              status: "passed",
              reason:
                "All displayed citation IDs refer to captured MCP tool outputs. Claim correctness is not established by this check.",
            },
          ],
          trust: null,
          receipt: buildReceipt(db, runId),
          corpusVersion,
        };
      } catch (error) {
        failure = sanitizeError(error);
        finishRun(db, runId, "failed");
        answer = {
          runId,
          status: "error",
          question: question.question,
          text: "The MCP comparison request could not complete.",
          asOf: null,
          claims: [],
          sources: [],
          checks: [],
          trust: null,
          receipt: buildReceipt(db, runId),
          corpusVersion,
          error: failure,
        };
      }
      run.rows.push({
        question,
        answer,
        verdict: "pending",
        inventedFacts: null,
        explanation:
          "Awaiting independent assessment against the same frozen references and captured MCP evidence. An API response is not a pass.",
      });
      save();
      console.log(
        `${run.id} ${question.id}: ${answer.status} $${answer.receipt.knownCostUsd.toFixed(5)}`,
      );
      if (failure && /budget/i.test(failure)) break;
    }
    run.status = run.rows.length === 20 ? "completed" : "incomplete";
    save();
    return run;
  } finally {
    db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const flags = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2)
    flags.set(process.argv[i], process.argv[i + 1]);
  const evidence = flags.get("--evidence");
  const out = flags.get("--out");
  if (!evidence || !out)
    throw new Error(
      "Usage: tsx scripts/evaluate-mcp.ts --evidence <mcp-evidence.json> --out <new-evaluation.json> [--db <sqlite path>]",
    );
  if (existsSync(".env")) loadEnvFile();
  await evaluateMcp({ evidence, out, dbPath: flags.get("--db") });
}
