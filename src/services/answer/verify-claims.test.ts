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
