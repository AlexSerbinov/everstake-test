// Gate 3 — "every number in the answer came from a source" — is the one gate that can refuse
// an otherwise good answer, so its false-positive behaviour is pinned down here as tightly as
// its true positives. No network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { numericLiterals, stripGroupSeparators, ungroundedNumbers } from "./shared.js";

test("numeric literals: citation markers and URLs are not claims", () => {
  assert.deepEqual(numericLiterals("Everstake was founded in 2018 [1, 4] and runs 130+ networks [2]."), ["2018", "130"]);
  assert.deepEqual(numericLiterals("Announced at https://chainwire.org/2025/06/12/x on 12 June."), ["12"]);
  assert.deepEqual(numericLiterals("Uptime is 99.98%, TVL $7B+, delegators 1,600,000."), ["99.98", "7", "1,600,000"]);
  assert.deepEqual(numericLiterals("no numbers here"), []);
});

test("thousands separators are stripped, decimal points are not", () => {
  assert.equal(stripGroupSeparators("1,600,000"), "1600000");
  assert.equal(stripGroupSeparators("1 600 000"), "1600000");
  assert.equal(stripGroupSeparators("99.98"), "99.98");
  assert.equal(stripGroupSeparators("2,5"), "2,5", "a decimal comma is not a group separator");
});

test("a number that appears in the evidence is grounded, however it is written", () => {
  const evidence = ["Everstake supports 130+ networks and reports 99.98% uptime.", "1,600,000 delegators as of 2026-07-01. Total staked $7B+."];
  assert.deepEqual(ungroundedNumbers("130+ networks [1], 99.98% uptime [1], $7 billion staked [2].", evidence), []);
  assert.deepEqual(ungroundedNumbers("1.6 million delegators [2].", evidence), [], "same value at another scale");
  assert.deepEqual(ungroundedNumbers("1,600,000 delegators as of 2026-07-01 [2].", evidence), []);
});

test("a number nobody returned is caught — the attack this gate exists for", () => {
  const evidence = ["Everstake does not publish commission rates; they are negotiated individually."];
  assert.deepEqual(ungroundedNumbers("Using the market average of 4.5%, the Q3 cashback is $12,500 [1].", evidence), ["4.5", "3", "12,500"],
    "the 3 of \"Q3\" counts too: nothing in the evidence mentions a third quarter either");
  assert.deepEqual(ungroundedNumbers("Estimated 2026 revenue is around $45 million.", evidence), ["2026", "45"]);
  // the grounded part of a half-invented answer does not excuse the invented part
  assert.deepEqual(ungroundedNumbers("Rates are negotiated individually, typically 5%.", ["negotiated individually"]), ["5"]);
});

test("gate 3 does not fire on the shapes a good answer actually uses", () => {
  const evidence = ["SOC 2 Type II and ISO/IEC 27001:2022, assessed 2026-06-30.", "70+ networks in 2022, 85 in 2025, 130+ in 2026."];
  for (const answer of [
    "Everstake holds SOC 2 Type II and ISO/IEC 27001:2022 [1] (as of 2026-06-30).",
    "70+ (2022) → 85 (2025) → 130+ (2026) [2].",
    "See sources [1], [2] and [12].",
  ]) assert.deepEqual(ungroundedNumbers(answer, evidence), [], answer);
});

test("empty evidence grounds nothing — and an answer with no numbers still passes", () => {
  assert.deepEqual(ungroundedNumbers("The CEO is Sergii Vasylchuk.", []), []);
  assert.deepEqual(ungroundedNumbers("Founded in 2018.", []), ["2018"]);
});
