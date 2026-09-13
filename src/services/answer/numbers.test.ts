import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarioNumbers } from "./calculate.js";
import { numbers, verifyAnswer } from "./verify-answer.js";
import type { EvidencePassage } from "../../contracts.js";

test("numeric grounding normalizes decimal commas without confusing thousands", () => {
  assert.deepEqual(numbers("Внесок 0,5 та 0,001 токена"), ["0.5", "0.001"]);
  assert.deepEqual(scenarioNumbers("Внесок 0,5 та 0,001 токена"), [0.5, 0.001]);
  assert.deepEqual(numbers("Budget 1,000 and 2,048.25 tokens"), [
    "1000",
    "2048.25",
  ]);
  assert.deepEqual(numbers("Бюджет 1 000 та 2\u202f048,25 токена"), [
    "1000",
    "2048.25",
  ]);
  assert.deepEqual(numbers("0.01, 0.001, 2.25"), ["0.01", "0.001", "2.25"]);
  const evidence = {
    id: "s",
    text: "Minimum 0.5 tokens",
    publishedAt: "2026-01-01",
    fetchedAt: "2026-01-01",
  } as EvidencePassage;
  const registry = new Map([["s", evidence]]);
  const check = (text: string) =>
    verifyAnswer(
      [{ text, citations: ["s"], asOf: "2026-01-01" }],
      registry,
      "",
    ).find((c) => c.rule.endsWith(":quantities"))?.status;
  assert.equal(check("Мінімум 0,5 токена"), "passed");
  assert.equal(check("Мінімум 5 токенів"), "failed");
  assert.equal(check("Мінімум 0,05 токена"), "failed");
});
