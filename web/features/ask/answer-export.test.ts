import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnswerResult, EvidencePassage } from "../../../src/contracts.js";
import { renderDatedClaims } from "../../../src/services/answer/claim-date.js";
import { answerText } from "./answer-export.js";

const source: EvidencePassage = {
  id: "ref/a[7]",
  documentId: "operations-report",
  url: "https://example.org/report#operations",
  title: "Operations report",
  publisher: "Example",
  authority: 1,
  text: "As of 2025-11-15, 24 sites are active.",
  publishedAt: "2026-01-10T12:00:00Z",
  updatedAt: null,
  fetchedAt: "2026-09-13T14:00:00Z",
  duplicateGroup: "operations-report",
  score: 1,
  reason: "Dated operations report",
  metadata: {},
};
function result(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return {
    runId: "export-test",
    status: "answered",
    question: "How many sites are active?",
    text: "Legacy unqualified answer text must not replace the dated claims.",
    asOf: null,
    claims: [
      {
        text: "The report lists 24 active sites.",
        citations: [source.id],
        asOf: "2025-11-15",
        asOfBasis: "effective",
        asOfSource: source.id,
      },
    ],
    sources: [source],
    checks: [],
    trust: null,
    receipt: {
      runId: "export-test",
      calls: 1,
      inputTokens: 40,
      outputTokens: 20,
      knownCostUsd: 0.001,
      unknownCalls: 0,
      elapsedMs: 1000,
    },
    corpusVersion: "corpus-export-test",
    ...overrides,
  };
}

test("export retains the UI's dated claims and distinct historical source dates", () => {
  const older = {
    ...source,
    id: "archive+2023",
    publishedAt: "2023-04-09",
    text: "The company operated 12 sites.",
  };
  const answer = result({
    status: "partial",
    sources: [source, older],
    claims: [
      ...result().claims,
      {
        text: "The earlier report lists 12 sites.",
        citations: [older.id],
        asOf: "2023-04-09",
        asOfBasis: "published",
      },
    ],
  });
  const text = answerText(answer.question, answer);
  assert.ok(text.includes(renderDatedClaims(answer.claims, answer.sources)));
  assert.match(text, /Fact as of 2025-11-15; source published 2026-01-10/);
  assert.match(
    text,
    /Source published 2023-04-09 \[archive\+2023\]; fact effective date not established/,
  );
  assert.ok(!text.includes(answer.text));
  assert.ok(text.startsWith(`${answer.question}\n\n`));
  assert.match(text, /Status: partial\nSource collection: corpus-export-test/);
});

test("exports preserve unknown fact dates and video upload limitations", () => {
  const video = {
    ...source,
    id: "video:40",
    url: "https://example.org/watch?t=40#speaker",
    metadata: { videoId: "video" },
  };
  const answer = result({
    sources: [source, video],
    claims: [
      {
        text: "The exact current count is not established.",
        citations: [source.id],
        asOf: null,
      },
      {
        text: "The speaker described 24 sites.",
        citations: [video.id],
        asOf: "2026-01-10",
        asOfBasis: "published",
      },
    ],
  });
  const text = answerText(answer.question, answer);
  assert.match(text, /Fact date not established\./);
  assert.match(
    text,
    /Source uploaded 2026-01-10 \[video:40\]; fact effective date not established/,
  );
  assert.ok(text.includes(video.url));
  assert.doesNotMatch(text, /Fact as of/);
});

for (const [status, message] of [
  [
    "no_reliable_answer",
    "No reliable answer was found in the available evidence.",
  ],
  ["error", "The provider request failed. Please try again."],
] as const) {
  test(`a ${status} export retains the plain response and its status`, () => {
    const answer = result({ status, text: message, claims: [], sources: [] });
    const text = answerText(answer.question, answer);
    assert.ok(text.includes(`\n\n${message}\n\nStatus: ${status}\n`));
    assert.doesNotMatch(text, /Fact as of|Source published|\[ref\/a/);
    if (status === "error")
      assert.doesNotMatch(text, /no_reliable_answer|No reliable answer/);
  });
}

test("exports keep original citation IDs resolvable and exclude unsafe source URLs", () => {
  const unsafeUrls = [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///private",
    "/relative",
    "//example.org",
  ];
  const answer = result({
    sources: [
      source,
      { ...source, id: "http-safe", url: "http://example.org/report" },
      ...unsafeUrls.map((url, index) => ({
        ...source,
        id: `unsafe-${index}`,
        url,
      })),
    ],
  });
  const text = answerText(answer.question, answer);
  assert.ok(text.includes(`The report lists 24 active sites. [${source.id}]`));
  assert.ok(text.includes(`[${source.id}] Operations report\n${source.url}`));
  assert.ok(
    text.includes("[http-safe] Operations report\nhttp://example.org/report"),
  );
  for (const [index, url] of unsafeUrls.entries()) {
    assert.ok(
      text.includes(
        `[unsafe-${index}] Operations report\nSource URL unavailable`,
      ),
    );
    assert.ok(!text.split("\n").includes(url));
  }
  assert.equal(
    text.match(/Source URL unavailable/g)?.length,
    unsafeUrls.length,
  );
});
