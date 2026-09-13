import { test } from "node:test";
import assert from "node:assert/strict";
import type { Claim, EvidencePassage } from "../../contracts.js";
import {
  commonEffectiveDate,
  normalizeClaimDate,
  renderDatedClaims,
  resolveClaimDate,
} from "./claim-date.js";
import { verifyAnswer } from "./verify-answer.js";

const source: EvidencePassage = {
  id: "dated",
  documentId: "doc",
  url: "https://example.org/report",
  title: "Operations report",
  publisher: "Example",
  authority: 1,
  text: "As of 2025-11-15, 24 sites are active. We have operated 96 sites over our lifetime.",
  publishedAt: "2026-01-10T12:00:00Z",
  updatedAt: "2026-08-20T00:00:00Z",
  fetchedAt: "2026-09-13T14:00:00Z",
  duplicateGroup: "doc",
  score: 1,
  reason: "Fixture",
  metadata: {},
};
const registry = new Map([[source.id, source]]);
const claim: Claim = {
  text: "The report lists 24 active sites.",
  citations: [source.id],
  asOf: "2026-01-10",
};

test("a saved publication date is labelled as publication, not silently promoted to fact validity", () => {
  const normalized = normalizeClaimDate(claim, registry);
  assert.equal(normalized.asOfBasis, "published");
  assert.equal(normalized.asOfSource, source.id);
  assert.equal(commonEffectiveDate([normalized]), null);
  const text = renderDatedClaims([claim], [source]);
  assert.match(text, /Source published 2026-01-10 \[dated\]/);
  assert.match(text, /fact effective date not established/);
});

test("a page update cannot be declared an effective fact date using metadata alone", () => {
  const incorrect: Claim = {
    ...claim,
    asOf: "2026-08-20",
    asOfBasis: "effective",
  };
  assert.equal(resolveClaimDate(incorrect, registry), null);
  assert.equal(
    verifyAnswer([incorrect], registry, "").find((c) =>
      c.rule.endsWith(":date"),
    )?.status,
    "failed",
  );
  assert.equal(
    resolveClaimDate({ ...incorrect, asOfBasis: "updated" }, registry)?.basis,
    "updated",
  );
  assert.match(
    renderDatedClaims([{ ...incorrect, asOfBasis: "updated" }], [source]),
    /Source updated 2026-08-20; source published 2026-01-10/,
  );
});

test("explicit fact dates require text support and remain distinct from publication and observation", () => {
  const explicit = normalizeClaimDate(
    { ...claim, asOf: "2025-11-15", asOfBasis: "effective" },
    registry,
  );
  assert.equal(commonEffectiveDate([explicit]), "2025-11-15");
  assert.match(
    renderDatedClaims([explicit], [source]),
    /Fact as of 2025-11-15/,
  );
  assert.equal(
    resolveClaimDate(
      { ...claim, asOf: "2026-09-13", asOfBasis: "observed" },
      registry,
    )?.basis,
    "observed",
  );
});

test("date origin must belong to this claim's cited evidence", () => {
  assert.equal(
    resolveClaimDate({ ...claim, asOfSource: "uncited" }, registry),
    null,
  );
  const other = { ...source, id: "other", publishedAt: "2024-03-02" };
  assert.equal(
    resolveClaimDate(
      { ...claim, asOf: "2024-03-02", asOfSource: "other" },
      new Map([...registry, [other.id, other]]),
    ),
    null,
  );
});

test("partial and impossible dates do not pass by substring matching", () => {
  for (const asOf of [
    "2026",
    "2026-01",
    "2026-02-30",
    "26-01-10",
    "2026-01-10junk",
    "",
  ]) {
    assert.equal(resolveClaimDate({ ...claim, asOf }, registry), null, asOf);
  }
});

test("each statement keeps its own cited date; the latest date does not date the whole answer", () => {
  const older = { ...source, id: "older", publishedAt: "2023-04-09" };
  const claims = [
    claim,
    { ...claim, citations: [older.id], asOf: "2023-04-09" },
  ];
  const text = renderDatedClaims(claims, [source, older]);
  assert.match(text, /Source published 2026-01-10 \[dated\]/);
  assert.match(text, /Source published 2023-04-09 \[older\]/);
  assert.equal(commonEffectiveDate(claims), null);
  assert.equal(
    commonEffectiveDate(claims.map((c) => ({ ...c, asOfBasis: "effective" }))),
    null,
  );
});

test("undated and video sources retain observation/upload limitations", () => {
  const undated = { ...source, publishedAt: null, updatedAt: null };
  const observed = { ...claim, asOf: "2026-09-13" };
  assert.match(
    renderDatedClaims([observed], [undated]),
    /Page checked 2026-09-13.*fact effective date not established/,
  );
  assert.match(
    renderDatedClaims([claim], [{ ...source, metadata: { videoId: "v" } }]),
    /Source uploaded 2026-01-10/,
  );
});

test("reviewed cumulative scope is explained in delivered text without inserting a company-specific fact", () => {
  const cumulative: Claim = {
    ...claim,
    text: "96 sites operated over the company's lifetime.",
    temporalScope: "cumulative",
  };
  assert.match(
    renderDatedClaims([cumulative], [source]),
    /^Cumulative total across time, not a previous simultaneous count\./,
  );
  assert.doesNotMatch(
    renderDatedClaims([{ ...claim, temporalScope: "current" }], [source]),
    /Cumulative total/,
  );
});
