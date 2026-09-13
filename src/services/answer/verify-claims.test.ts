import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyClaims } from "./verify-claims.js";
import type { EvidencePassage, ModelClient } from "../../contracts.js";
const source = (id: string, text: string): EvidencePassage => ({
  id,
  documentId: id,
  url: `https://example.com/${id}`,
  title: id,
  text,
  authority: 1,
  publisher: "Example",
  publishedAt: "2026-01-01",
  updatedAt: null,
  fetchedAt: "2026-09-13",
  duplicateGroup: id,
  score: 1,
  reason: "Fixture",
  metadata: {},
});
test("support review receives uncited counterevidence before approving a universal claim", async () => {
  const required = source("required", "Requests require a token.");
  const exception = source(
    "exception",
    "A token is optional for prepaid customers.",
  );
  const model: ModelClient = {
    generate: async (request) => {
      const input = JSON.parse(request.messages[0]!.text);
      const hasException = input.otherRetrievedEvidence.some(
        (s: EvidencePassage) => s.id === "exception",
      );
      return {
        text: JSON.stringify({
          questionMode: "factual",
          answerScope: {
            supported: true,
            reason: "The answer addresses the requested scope",
          },
          checks: [
            {
              claimIndex: 0,
              supported: !hasException,
              reason: "A prepaid exception limits the universal claim",
            },
          ],
        }),
        model: "fixture",
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  const result = await verifyClaims(
    model,
    "run",
    [
      {
        text: "Every request requires a token without exception.",
        citations: ["required"],
        asOf: "2026-01-01",
      },
    ],
    new Map([
      [required.id, required],
      [exception.id, exception],
    ]),
    "Is a token always required?",
  );
  assert.equal(result[0]!.status, "failed");
});
test("a present-tense claim superseded by newer evidence fails the currentness check", async () => {
  const announcement = source("announcement", "Alice becomes chief executive.");
  const about = {
    ...source("about", "Bob, Chief Executive Officer."),
    publishedAt: "2026-07-01",
  };
  const model: ModelClient = {
    generate: async (request) => {
      const input = JSON.parse(request.messages[0]!.text);
      const newer = input.claims[0].newerEvidence.map(
        (s: EvidencePassage) => s.id,
      );
      assert.deepEqual(newer, ["about"]);
      return {
        text: JSON.stringify({
          questionMode: "factual",
          answerScope: {
            supported: true,
            reason: "The answer addresses the requested scope",
          },
          checks: [
            {
              claimIndex: 0,
              supported: false,
              supersededByNewer: true,
              reason:
                "The newer company page names a different chief executive",
            },
          ],
        }),
        model: "fixture",
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
  const checks = await verifyClaims(
    model,
    "run",
    [
      {
        text: "Alice is the CEO.",
        citations: ["announcement"],
        asOf: "2025-06-12",
      },
    ],
    new Map([
      [announcement.id, announcement],
      [about.id, about],
    ]),
    "Who is the CEO?",
    undefined,
    [{ claimIndex: 0, newer: [about], exceptions: [] }],
  );
  const currentness = checks.find((c) => c.rule === "claim-1:currentness")!;
  assert.equal(currentness.status, "failed");
  assert.match(currentness.reason, /2026-07-01/);
});
test("a focused review by the answer model can supersede a claim the general review approved", async () => {
  const announcement = source("announcement", "Alice becomes chief executive.");
  const about = {
    ...source("about", "Team: Bob, CEO. Alice, CCDO."),
    publishedAt: "2026-07-01",
  };
  const stages: string[] = [];
  const model: ModelClient = {
    generate: async (request) => {
      stages.push(request.stage);
      const text =
        request.stage === "currentness-review"
          ? JSON.stringify({
              superseded: true,
              reason: "The newer team page lists Bob as CEO and Alice as CCDO",
            })
          : JSON.stringify({
              questionMode: "factual",
              answerScope: {
                supported: true,
                reason: "The answer addresses the requested scope",
              },
              checks: [
                {
                  claimIndex: 0,
                  supported: true,
                  supersededByNewer: false,
                  reason: "Cited announcement says so",
                },
              ],
            });
      return { text, model: "fixture", inputTokens: 0, outputTokens: 0 };
    },
  };
  const checks = await verifyClaims(
    model,
    "run",
    [
      {
        text: "Alice is the CEO.",
        citations: ["announcement"],
        asOf: "2025-06-12",
      },
    ],
    new Map([
      [announcement.id, announcement],
      [about.id, about],
    ]),
    "Who is the CEO?",
    undefined,
    [{ claimIndex: 0, newer: [about], exceptions: [] }],
  );
  assert.deepEqual(stages, ["claim-verification", "currentness-review"]);
  assert.equal(
    checks.find((c) => c.rule === "claim-1:support")!.status,
    "failed",
  );
  assert.match(
    checks.find((c) => c.rule === "claim-1:currentness")!.reason,
    /Bob as CEO/,
  );
});

test("individually supported quantities cannot bypass a failed whole-answer comparison", async () => {
  const passage = source(
    "counts",
    "24 active sites; 96 sites operated over our lifetime.",
  );
  const checks = await verifyClaims(
    {
      generate: async () => ({
        text: JSON.stringify({
          questionMode: "factual",
          answerScope: {
            supported: false,
            reason:
              "The answer must distinguish cumulative experience from a previous simultaneous count",
          },
          checks: [0, 1].map((claimIndex) => ({
            claimIndex,
            supported: true,
            reason: "The individual quantity is in the passage",
          })),
        }),
        model: "fixture",
        inputTokens: 0,
        outputTokens: 0,
      }),
    },
    "run",
    [
      {
        text: "Currently 24 sites.",
        citations: [passage.id],
        asOf: "2026-01-01",
      },
      {
        text: "Historically 96 sites.",
        citations: [passage.id],
        asOf: "2026-01-01",
      },
    ],
    new Map([[passage.id, passage]]),
    "How many sites are active?",
  );
  assert.equal(
    checks
      .filter((c) => c.rule.endsWith(":support"))
      .every((c) => c.status === "passed"),
    true,
  );
  assert.equal(checks.find((c) => c.rule === "answer-scope")?.status, "failed");
});

test("a focused multi-value review can reject a relationship approved by the lightweight reviewer", async () => {
  const passage = source(
    "counts",
    "24 active sites; 96 sites operated over our lifetime.",
  );
  const stages: string[] = [];
  const checks = await verifyClaims(
    {
      generate: async (request) => {
        stages.push(request.stage);
        return {
          text: JSON.stringify(
            request.stage === "answer-scope-review"
              ? {
                  supported: false,
                  reason: "Cumulative experience does not establish a decline",
                }
              : {
                  questionMode: "factual",
                  answerScope: { supported: true, reason: "Numbers match" },
                  checks: [
                    { claimIndex: 0, supported: true, reason: "Numbers match" },
                  ],
                },
          ),
          model: "fixture",
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    },
    "run",
    [
      {
        text: "Active sites declined from 96 to 24.",
        citations: [passage.id],
        asOf: "2026-01-01",
      },
    ],
    new Map([[passage.id, passage]]),
    "How many sites are active?",
  );
  assert.deepEqual(stages, ["claim-verification", "answer-scope-review"]);
  assert.equal(checks.find((c) => c.rule === "answer-scope")?.status, "failed");
});

test("an unreadable focused comparison is an error, never a silent approval", async () => {
  const passage = source("counts", "24 active sites; 96 lifetime sites.");
  await assert.rejects(
    verifyClaims(
      {
        generate: async (request) => ({
          text:
            request.stage === "answer-scope-review"
              ? "invalid"
              : JSON.stringify({
                  questionMode: "factual",
                  answerScope: { supported: true, reason: "Matches" },
                  checks: [
                    { claimIndex: 0, supported: true, reason: "Matches" },
                  ],
                }),
          model: "fixture",
          inputTokens: 0,
          outputTokens: 0,
        }),
      },
      "run",
      [
        {
          text: "24 active sites; 96 lifetime sites.",
          citations: [passage.id],
          asOf: "2026-01-01",
        },
      ],
      new Map([[passage.id, passage]]),
      "How many sites are active?",
    ),
  );
});
