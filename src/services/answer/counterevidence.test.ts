import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvidencePassage } from "../../contracts.js";
import {
  ABSOLUTE_WORDING,
  exceptionQuery,
  gatherCounterevidence,
  isNewerCandidate,
} from "./counterevidence.js";
const source = (
  id: string,
  text: string,
  publishedAt: string | null,
  authority: 1 | 2 | 3 = 1,
): EvidencePassage => ({
  id,
  documentId: id,
  url: `https://example.com/${id}`,
  title: id,
  text,
  authority,
  publisher: "Example",
  publishedAt,
  updatedAt: null,
  fetchedAt: "2026-09-13",
  duplicateGroup: id,
  score: 1,
  reason: "Fixture",
  metadata: {},
});
test("newer candidates need a date after the claim, equal or higher authority and no citation", () => {
  const cited = source("old", "Alice is the chief executive.", "2025-06-12");
  const claim = {
    text: "Alice is CEO.",
    citations: ["old"],
    asOf: "2025-06-12",
  };
  assert.equal(
    isNewerCandidate(
      claim,
      [cited],
      source("about", "Bob is CEO.", "2026-07-01"),
    ),
    true,
  );
  assert.equal(
    isNewerCandidate(
      claim,
      [cited],
      source("older", "Alice founded it.", "2023-01-01"),
    ),
    false,
  );
  assert.equal(
    isNewerCandidate(claim, [cited], source("undated", "Bob is CEO.", null)),
    false,
  );
  assert.equal(
    isNewerCandidate(
      claim,
      [cited],
      source("blog", "Bob is CEO.", "2026-07-01", 3),
    ),
    false,
  );
  assert.equal(isNewerCandidate(claim, [cited], cited), false);
});
test("absolute wording triggers an exception search and newer pages are ranked newest first", async () => {
  const queries: string[] = [];
  const search = async (query: string) => {
    queries.push(query);
    return query.includes("optional")
      ? [
          source(
            "waiver",
            "A tip is optional on the single path.",
            "2026-03-01",
          ),
        ]
      : [
          source("mid", "Tips are mandatory.", "2026-01-01"),
          source(
            "newest",
            "Tips are mandatory except on the single path.",
            "2026-08-01",
          ),
          source("old", "Tips are mandatory.", "2025-01-01"),
        ];
  };
  const registry = new Map([
    ["old", source("old", "Tips are mandatory.", "2025-01-01")],
  ]);
  const [result] = await gatherCounterevidence(
    [
      {
        text: "Every transaction must carry a tip.",
        citations: ["old"],
        asOf: "2025-01-01",
      },
    ],
    registry,
    search,
  );
  assert.equal(
    ABSOLUTE_WORDING.test("Every transaction must carry a tip."),
    true,
  );
  assert.equal(queries.length, 2);
  assert.deepEqual(
    result!.newer.map((s) => s.id),
    ["newest", "mid"],
  );
  assert.deepEqual(
    result!.exceptions.map((s) => s.id),
    ["waiver"],
  );
});
test("plain claims run only the subject search", async () => {
  let calls = 0;
  const [result] = await gatherCounterevidence(
    [{ text: "Founded in 2018.", citations: ["a"], asOf: "2023-01-01" }],
    new Map([["a", source("a", "Founded in 2018.", "2023-01-01")]]),
    async () => {
      calls++;
      return [];
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result!.exceptions, []);
});
test("the exception query names the subject next to the absolute term, not the whole claim", () => {
  const query = exceptionQuery(
    "According to documentation on the page checked on 2026-09-13, the tip is not optional, and the submitted transaction must include a tip-transfer instruction.",
  );
  assert.match(query, /tip/);
  assert.match(query, /optional exception except unless/);
  assert.doesNotMatch(query, /documentation|checked|2026/);
});
