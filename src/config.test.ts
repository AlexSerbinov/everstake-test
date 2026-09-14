import assert from "node:assert/strict";
import { test } from "node:test";
import {
  policySchema,
  researcherSchema,
  readPolicy,
  readResearcher,
  readSources,
} from "./config.js";

test("shipped source, researcher and policy settings are valid", () => {
  assert.ok(readSources().length);
  assert.equal(readResearcher().maxSteps, 6);
  assert.equal(readPolicy().maxRunCostUsd, 0.3);
});

test("policy rejects ignored fields, invalid budgets and misleading score totals", () => {
  const policy = readPolicy();
  for (const change of [
    { maxToolSteps: 10 },
    { crawlConcurrency: 5 },
    { maxRunCostUsd: -1 },
    { maxOutputTokens: 9000 },
    { trust: { ...policy.trust, authority: 99 } },
  ])
    assert.equal(
      policySchema.safeParse({ ...policy, ...change }).success,
      false,
    );
});

test("researcher limits are numeric and action inventory must match code", () => {
  const researcher = readResearcher();
  // Reject edits the old loop silently clamped, so a live change has its stated effect.
  assert.equal(
    researcherSchema.safeParse({ ...researcher, maxSteps: 9 }).success,
    false,
  );
  assert.equal(
    researcherSchema.safeParse({ ...researcher, maxRepairSteps: 3 }).success,
    false,
  );
  const { maxRepairSteps, ...withoutRepairLimit } = researcher;
  assert.equal(researcherSchema.parse(withoutRepairLimit).maxRepairSteps, 1);
  assert.equal(
    researcherSchema.safeParse({ ...researcher, maxSteps: "6" }).success,
    false,
  );
  assert.equal(
    researcherSchema.safeParse({ ...researcher, maxRepairSteps: -1 }).success,
    false,
  );
  assert.equal(
    researcherSchema.safeParse({ ...researcher, tools: ["search", "answer"] })
      .success,
    false,
  );
  assert.equal(
    researcherSchema.safeParse({
      ...researcher,
      tools: ["search", "search", "read", "answer"],
    }).success,
    false,
  );
  assert.equal(
    researcherSchema.safeParse({
      ...researcher,
      tools: ["search", "read", "calculate", "fetch"],
    }).success,
    false,
  );
});
