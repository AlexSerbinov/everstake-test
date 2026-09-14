import { readFileSync } from "node:fs";
import { readPolicy, readResearcher } from "../../config.js";
import type {
  AnswerResult,
  Emit,
  EvidencePassage,
  ModelClient,
  ModelMessage,
  Receipt,
} from "../../contracts.js";
import { getSetting, type Database } from "../../storage/database.js";
import { readDocument, searchCorpus } from "../search/search-corpus.js";
import { scoreEvidence } from "../trust/score-evidence.js";
import {
  createCalculationEvidence,
  updateEvidenceWindow,
} from "./research-evidence.js";
import { parseResearchAction, type ResearchAction } from "./research-action.js";
import { verifyClaims } from "./verify-claims.js";
import { gatherCounterevidence } from "./counterevidence.js";
import { cancelledError } from "../../providers/model-client.js";
import { verifyAnswer } from "./verify-answer.js";
import {
  commonEffectiveDate,
  normalizeClaimDate,
  renderDatedClaims,
} from "./claim-date.js";

export interface AnswerDependencies {
  db: Database;
  model: ModelClient;
  search?: (query: string, limit?: number) => Promise<EvidencePassage[]>;
  receipt: (runId: string) => Receipt;
  finish: (runId: string, status: string) => void;
  /** Aborts provider calls and stops the loop when the client goes away. */
  signal?: AbortSignal;
}
export async function answerQuestion(
  deps: AnswerDependencies,
  question: string,
  runId: string,
  emit: Emit = () => {},
  mode: "agent" | "baseline" = "agent",
): Promise<AnswerResult> {
  const { db, model, signal } = deps;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw cancelledError();
  };
  const search =
    deps.search ??
    (async (query: string, limit = 12) => searchCorpus(db, query, limit));
  const send = (
    type: Parameters<Emit>[0]["type"],
    label: string,
    data?: unknown,
  ) => emit({ runId, type, label, data, at: new Date().toISOString() });
  const definition = readResearcher();
  const system =
    mode === "baseline"
      ? readFileSync("assistant/prompts/baseline.md", "utf8")
      : [
          readFileSync(definition.prompt, "utf8"),
          ...definition.skills.map((p) => readFileSync(p, "utf8")),
        ].join("\n\n");
  let answeredAction = false;
  const policy = readPolicy();
  const evidenceLimit = Math.max(6, Math.min(policy.maxEvidence, 30));
  const registry = new Map<string, EvidencePassage>();
  const messages: ModelMessage[] = [{ role: "user", text: question }];
  let result: AnswerResult = {
    runId,
    status: "no_reliable_answer",
    question,
    text: "No reliable answer was found in the available evidence.",
    asOf: null,
    claims: [],
    sources: [],
    checks: [],
    trust: null,
    receipt: deps.receipt(runId),
    corpusVersion: getSetting(db, "corpus_version", "unbuilt"),
  };
  const register = (
    sources: EvidencePassage[],
    label = (fresh: number, repeated: number) =>
      `Found ${fresh} new passages, ${repeated} already seen`,
    keep: string[] = [],
  ) => {
    const { fresh, repeated } = updateEvidenceWindow(
      registry,
      sources,
      evidenceLimit,
      keep,
    );
    send("sources", label(fresh, repeated), {
      sources,
      newCount: fresh,
      repeated,
    });
  };
  try {
    send("step", "Searching the crawled corpus");
    const initial = await search(question, mode === "baseline" ? 6 : 12);
    register(initial);
    messages.push({
      role: "user",
      text: JSON.stringify({ untrustedEvidence: initial }),
    });
    const steps = mode === "baseline" ? 1 : definition.maxSteps;
    // Extra turns can repair a rejected draft, but cannot call research tools.
    const repairSteps = mode === "agent" ? definition.maxRepairSteps : 0;
    for (let step = 0; step < steps + repairSteps; step++) {
      throwIfCancelled();
      send(
        "step",
        mode === "baseline"
          ? "Generating plain-RAG baseline"
          : step >= steps
            ? "Final answer repair"
            : `Research step ${step + 1} of ${steps}`,
      );
      const instruction =
        mode === "baseline"
          ? "Return answer action now using only supplied initial passages."
          : step >= steps - 1
            ? "This is your final turn: return answer action using evidence collected so far."
            : "";
      const response = await model.generate({
        runId,
        stage: mode === "baseline" ? "baseline" : "answer",
        system,
        messages: [
          messages[0]!,
          ...messages
            .slice(1)
            .filter(
              (m) =>
                !m.text.startsWith('{"untrustedEvidence":') &&
                !m.text.startsWith('{"calculation":'),
            )
            .slice(-8),
          {
            role: "user",
            text: JSON.stringify({
              untrustedEvidence: [...registry.values()],
              instruction:
                instruction ||
                "Choose the next research action. Only these evidence IDs are currently available; search again if an earlier passage is needed.",
            }),
          },
        ],
        maxOutputTokens: Math.min(policy.maxOutputTokens, 4000),
        thinkingLevel: policy.answerThinkingLevel,
        signal,
      });
      messages.push({ role: "model", text: response.text });
      let action: ResearchAction;
      try {
        action = parseResearchAction(response.text);
      } catch {
        messages.push({
          role: "user",
          text: "Invalid action schema. Return one valid JSON action; this consumes a research step.",
        });
        continue;
      }
      if (action.action === "answer") {
        if (action.status === "no_reliable_answer") {
          answeredAction = true;
          result.checks = [
            {
              rule: "abstention",
              status: "passed",
              reason: "No factual claims emitted",
            },
          ];
          break;
        }
        action.claims = action.claims.map((claim) =>
          normalizeClaimDate(claim, registry),
        );
        // Cheap deterministic checks gate the paid semantic review.
        const checks = verifyAnswer(action.claims, registry, question);
        if (!action.claims.length)
          checks.push({
            rule: "nonempty",
            status: "failed",
            reason: "Answer has no claims",
          });
        if (!checks.some((c) => c.status === "failed")) {
          send("step", "Looking for newer evidence and exceptions");
          const counterevidence = await gatherCounterevidence(
            action.claims,
            registry,
            search,
            3,
            question,
          );
          const found = counterevidence.flatMap((c) => [
            ...c.newer,
            ...c.exceptions,
            ...(c.related ?? []),
          ]);
          if (found.length)
            register(
              found,
              (fresh) =>
                `Compared ${fresh} newer or exception passages against the draft`,
              action.claims.flatMap((c) => c.citations),
            );
          checks.push(
            ...(await verifyClaims(
              model,
              runId,
              action.claims,
              registry,
              question,
              signal,
              counterevidence,
            )),
          );
        }
        send(
          "verification",
          "Checking citations, dates, quantities and support",
          checks,
        );
        if (checks.some((c) => c.status === "failed")) {
          result.checks = checks;
          messages.push({
            role: "user",
            text: JSON.stringify({
              rejectedDraftChecks: checks,
              instruction: readFileSync(
                "assistant/prompts/answer-repair.md",
                "utf8",
              ).trim(),
            }),
          });
          continue;
        }
        answeredAction = true;
        const ids = new Set(action.claims.flatMap((c) => c.citations));
        const sources = [...ids].map((id) => registry.get(id)!);
        result = {
          ...result,
          status: action.status,
          claims: action.claims,
          checks,
          sources,
          asOf: commonEffectiveDate(action.claims),
          text: renderDatedClaims(action.claims, sources),
          trust: scoreEvidence(sources, checks),
        };
        break;
      }
      if (mode === "baseline" || step >= steps) break;
      if (action.action === "search") {
        send("step", `Search: ${action.query}`);
        const sources = await search(action.query);
        register(sources);
        messages.push({
          role: "user",
          text: JSON.stringify({ untrustedEvidence: sources }),
        });
      } else if (action.action === "read") {
        if (
          ![...registry.values()].some(
            (s) => s.documentId === action.documentId,
          )
        ) {
          messages.push({
            role: "user",
            text: "Read requires a document ID returned by search.",
          });
          continue;
        }
        const sources = readDocument(
          db,
          action.documentId,
          action.offset,
          action.query,
        );
        register(sources);
        messages.push({
          role: "user",
          text: JSON.stringify({
            untrustedEvidence: sources,
            nextOffset: sources[0]?.metadata.nextOffset ?? null,
            query: action.query ?? null,
            instruction: sources.length
              ? "For another aspect, read with a different query and offset 0. nextOffset continues this query only."
              : "No matching indexed passage at this offset. Try a different query or read sequentially; this does not prove the fact is absent.",
          }),
        });
      } else {
        const evidence = createCalculationEvidence(action, registry, question);
        if (!evidence) {
          messages.push({
            role: "user",
            text: "Calculation requires cited sources and operands present in the question or cited evidence.",
          });
          continue;
        }
        register([evidence]);
        messages.push({
          role: "user",
          text: JSON.stringify({ calculation: evidence }),
        });
      }
    }
    // An exhausted or failed run is not evidence that the corpus lacks an answer.
    if (!answeredAction)
      throw new Error(
        "Research exhausted its step limit without a valid final answer",
      );
  } catch (error) {
    const cancelled = signal?.aborted ?? false;
    result = {
      ...result,
      status: "error",
      text: cancelled
        ? "The request was stopped before an answer was assembled."
        : "The request could not complete. Check provider availability or the configured budget.",
      error: cancelled
        ? "Request cancelled by the user"
        : error instanceof Error
          ? error.message
          : "Unknown provider error",
      trust: null,
    };
    send("error", cancelled ? "Request stopped" : "Request failed", {
      message: result.error,
    });
  }
  deps.finish(runId, signal?.aborted ? "cancelled" : result.status);
  result.receipt = deps.receipt(runId);
  db.prepare("INSERT OR REPLACE INTO answers(run_id,result) VALUES(?,?)").run(
    runId,
    JSON.stringify(result),
  );
  send("answer", "Final result", result);
  send("done", "Run finished", { status: result.status });
  return result;
}
