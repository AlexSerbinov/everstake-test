import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvidencePassage } from "../../contracts.js";
import {
  createCalculationEvidence,
  updateEvidenceWindow,
} from "./research-evidence.js";

const source = (
  id: string,
  text = "The minimum stake is 32 ETH.",
): EvidencePassage => ({
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

test("counterevidence cannot evict cited draft passages from the bounded repair window", () => {
  const cited = source("cited");
  const older = source("older");
  const registry = new Map([
    [older.id, older],
    [cited.id, cited],
  ]);
  const counts = updateEvidenceWindow(
    registry,
    [source("newer"), older, source("exception")],
    3,
    [cited.id],
  );
  assert.deepEqual([...registry.keys()], ["cited", "newer", "exception"]);
  assert.deepEqual(counts, { fresh: 2, repeated: 1 });
  assert.equal(registry.get(cited.id), cited);
});

test("scenario calculations retain cited inputs and generate a citable result", () => {
  const passage = source("stake");
  const registry = new Map([[passage.id, passage]]);
  const evidence = createCalculationEvidence(
    { action: "calculate", expression: "32 * 2", citations: [passage.id] },
    registry,
    "What is required for two validators?",
  );
  assert.ok(evidence);
  assert.match(evidence.id, /^calc-/);
  assert.match(evidence.text, /= 64;/);
  assert.ok(evidence.text.includes(passage.text));
  assert.equal(evidence.url, passage.url);
  assert.equal(
    (evidence.metadata.calculation as { result: number }).result,
    64,
  );
});

test("calculations reject invented operands and citations even when arithmetic is valid", () => {
  const passage = source("stake");
  const registry = new Map([[passage.id, passage]]);
  assert.equal(
    createCalculationEvidence(
      { action: "calculate", expression: "32 * 7", citations: [passage.id] },
      registry,
      "For two validators?",
    ),
    null,
  );
  assert.equal(
    createCalculationEvidence(
      { action: "calculate", expression: "32 * 2", citations: ["invented"] },
      registry,
      "For two validators at 32 ETH?",
    ),
    null,
  );
});

test("invalid arithmetic remains a tool error rather than an evidence rejection", () => {
  const passage = source("stake");
  assert.throws(
    () =>
      createCalculationEvidence(
        { action: "calculate", expression: "32 / 0", citations: [passage.id] },
        new Map([[passage.id, passage]]),
        "At 0 validators?",
      ),
    /Non-finite result/,
  );
});
