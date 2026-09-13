import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../storage/database.js";
import { answerQuestion } from "./answer-question.js";
import { verifyAnswer } from "./verify-answer.js";
import { calculate } from "./calculate.js";
import type { EvidencePassage } from "../../contracts.js";
test("provider errors are errors, not abstentions", async () => {
  const db = openDatabase(":memory:");
  const events: string[] = [];
  const result = await answerQuestion(
    {
      db,
      model: {
        generate: async () => {
          throw new Error("Provider unavailable");
        },
      },
      finish: () => {},
      receipt: (id) => ({
        runId: id,
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        knownCostUsd: 0,
        unknownCalls: 1,
        elapsedMs: 10,
      }),
    },
    "Unknown role?",
    "r",
    (e) => events.push(e.type),
  );
  assert.equal(result.status, "error");
  assert.equal(result.trust, null);
  assert.equal(events.at(-1), "done");
  db.close();
});
test("invented citations and quantities cannot pass", () => {
  const checks = verifyAnswer(
    [{ text: "Supports 2700 networks", citations: ["invented"], asOf: null }],
    new Map(),
    "",
  );
  assert.equal(checks.filter((c) => c.status === "failed").length, 3);
});
test("calculator supports bounded arithmetic and rejects executable operations", () => {
  assert.equal(calculate("multiply", [64, 32]), 2048);
  assert.throws(() => calculate("eval", [1, 2]));
  assert.throws(() => calculate("divide", [1, 0]));
});
test("malformed final actions are infrastructure errors, not corpus absence", async () => {
  const db = openDatabase(":memory:");
  const result = await answerQuestion(
    {
      db,
      model: {
        generate: async () => ({
          text: "invalid",
          model: "mock",
          inputTokens: 0,
          outputTokens: 0,
        }),
      },
      finish: () => {},
      receipt: (id) => ({
        runId: id,
        calls: 6,
        inputTokens: 0,
        outputTokens: 0,
        knownCostUsd: 0,
        unknownCalls: 0,
        elapsedMs: 10,
      }),
    },
    "Anything?",
    "bad",
  );
  assert.equal(result.status, "error");
  db.close();
});
test("a cancelled request stops the loop, records cancellation and never becomes an abstention", async () => {
  const db = openDatabase(":memory:");
  const controller = new AbortController();
  let finished = "";
  const events: string[] = [];
  const result = await answerQuestion(
    {
      db,
      model: {
        generate: async (request) => {
          controller.abort();
          assert.equal(request.signal?.aborted, true);
          throw Object.assign(new Error("fetch aborted"), {
            name: "AbortError",
          });
        },
      },
      search: async () => [],
      finish: (_id, status) => {
        finished = status;
      },
      receipt: (id) => ({
        runId: id,
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        knownCostUsd: 0,
        unknownCalls: 1,
        elapsedMs: 10,
      }),
      signal: controller.signal,
    },
    "Who leads the company?",
    "cancelled-run",
    (e) => events.push(`${e.type}:${e.label}`),
  );
  assert.equal(result.status, "error");
  assert.equal(result.error, "Request cancelled by the user");
  assert.equal(finished, "cancelled");
  assert.equal(events.includes("error:Request stopped"), true);
  db.close();
});

for (const lateRepair of [false, true])
  test(`the answer loop rejects a metadata-only effective date and renders the repaired source date (late repair: ${lateRepair})`, async () => {
    const db = openDatabase(":memory:");
    const source: EvidencePassage = {
      id: "source",
      documentId: "doc",
      url: "https://example.org/report",
      title: "Report",
      publisher: "Example",
      authority: 1,
      text: "There are 24 active sites and 96 sites operated over our lifetime.",
      publishedAt: "2026-04-03",
      updatedAt: "2026-09-10",
      fetchedAt: "2026-09-13",
      duplicateGroup: "doc",
      score: 1,
      reason: "Fixture",
      metadata: {},
    };
    let drafts = 0;
    const result = await answerQuestion(
      {
        db,
        search: async () => [source],
        model: {
          generate: async (request) => {
            let response;
            if (request.stage === "answer-scope-review") {
              response = {
                supported: true,
                unsupportedAssumptions: [],
                reason: "The dated statement answers the question",
              };
            } else if (request.stage === "claim-verification") {
              const input = JSON.parse(request.messages[0]!.text);
              assert.equal(input.claims[0].claim.asOfBasis, "published");
              assert.equal(input.claims[0].claim.asOfSource, source.id);
              response = {
                questionMode: "factual",
                answerScope: {
                  supported: true,
                  reason: "The answer addresses the requested scope",
                },
                checks: [
                  {
                    claimIndex: 0,
                    supported: true,
                    reason: "Dated report, not a claim of current verification",
                  },
                ],
              };
            } else {
              drafts++;
              if (lateRepair && drafts < 6)
                return {
                  text: JSON.stringify({
                    action: "search",
                    query: "operations report",
                  }),
                  model: "fixture",
                  inputTokens: 0,
                  outputTokens: 0,
                };
              if (lateRepair && drafts === 7)
                return {
                  text: '{"action":',
                  model: "fixture",
                  inputTokens: 0,
                  outputTokens: 0,
                };
              const invalidDate = drafts === (lateRepair ? 6 : 1);
              response = {
                action: "answer",
                status: "answered",
                claims: [
                  {
                    text: "The report lists 24 active sites.",
                    citations: [source.id],
                    asOf: invalidDate ? "2026-09-10" : "2026-04-03",
                    asOfBasis: invalidDate ? "effective" : "published",
                    asOfSource: source.id,
                  },
                ],
              };
            }
            return {
              text: JSON.stringify(response),
              model: "fixture",
              inputTokens: 0,
              outputTokens: 0,
            };
          },
        },
        finish: () => {},
        receipt: (runId) => ({
          runId,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          knownCostUsd: 0,
          unknownCalls: 0,
          elapsedMs: 0,
        }),
      },
      "What active-site count does the report give?",
      "dated-answer",
    );
    assert.equal(drafts, lateRepair ? 8 : 2);
    assert.equal(result.status, "answered");
    assert.equal(result.asOf, null);
    assert.match(result.text, /Source published 2026-04-03 \[source\]/);
    assert.doesNotMatch(result.text, /2026-09-10/);
    assert.equal(
      JSON.parse(
        String(
          db
            .prepare("SELECT result FROM answers WHERE run_id=?")
            .get("dated-answer")!.result,
        ),
      ).text,
      result.text,
    );
    db.close();
  });
