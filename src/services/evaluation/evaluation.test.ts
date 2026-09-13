import { test } from "node:test";
import assert from "node:assert/strict";
import { readQuestions } from "./run-evaluation.js";

test("core keeps leadership and conflicting sources while scenarios stay separate", () => {
  const core = readQuestions();
  const scenarios = readQuestions("scenarios");
  for (const id of ["E01", "E02", "E04", "E05", "E06", "E14", "E15"])
    assert.ok(core.some((q) => q.id === id));
  assert.ok(core.some((q) => q.id === "E21"));
  assert.equal(
    core.some((q) => q.id === "E03"),
    false,
  );
  assert.equal(scenarios.length, 7);
  assert.equal(new Set([...core, ...scenarios].map((q) => q.id)).size, 27);
});
