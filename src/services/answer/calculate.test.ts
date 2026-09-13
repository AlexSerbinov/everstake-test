import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateExpression, scenarioNumbers } from "./calculate.js";
test("arithmetic expressions retain intermediate evidence and precedence", () => {
  const result = calculateExpression("(3 * 199 + 2 * 499) * 12");
  assert.equal(result.value, 19140);
  assert.ok(result.steps.some((s) => s.endsWith("= 1595")));
  assert.deepEqual(result.operands, [3, 199, 2, 499, 12]);
  assert.equal(calculateExpression("2 + 3 * 4").value, 14);
});
test("arithmetic rejects code, malformed input, overflow and division by zero", () => {
  for (const input of [
    "process.exit()",
    "2**3",
    "1/0",
    "(2+3",
    "1e10",
    "10000000000000+1",
    "2..3",
  ])
    assert.throws(() => calculateExpression(input));
});

test("written scenario quantities stay explicit user assumptions", () => {
  assert.deepEqual(
    scenarioNumbers("three plans and two plans for twelve months"),
    [3, 2, 12],
  );
  assert.deepEqual(scenarioNumbers("три плани на дванадцять місяців"), [3, 12]);
});
