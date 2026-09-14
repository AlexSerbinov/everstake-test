import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvidencePassage } from "../../../src/contracts.js";
import {
  citationSegments,
  groupSources,
  passageAnchor,
} from "./citation-navigation.js";
import { safeUrl } from "../../shared/dom.js";
const source = (id: string, documentId: string): EvidencePassage => ({
  id,
  documentId,
  url: `https://example.com/${documentId}`,
  title: "Evidence",
  text: "A quoted fact",
  authority: 1,
  publisher: "Publisher",
  publishedAt: null,
  updatedAt: null,
  fetchedAt: "2026-09-13",
  duplicateGroup: documentId,
  score: 1,
  reason: "Matched",
  metadata: {},
});
test("groups passages from a page without losing stable references or duplicating hits", () => {
  const first = source("ref/a[7]", "same-page");
  const second = source("arbitrary-id-99", "same-page");
  const groups = groupSources([
    first,
    source("other", "other-page"),
    second,
    first,
  ]);
  assert.deepEqual(
    groups.map((group) => group.map((row) => row.id)),
    [["ref/a[7]", "arbitrary-id-99"], ["other"]],
  );
});
test("passage anchors preserve arbitrary identities without selector or scope collisions", () => {
  assert.notEqual(
    passageAnchor("answer-1", "a/b"),
    passageAnchor("answer-1", "a%2Fb"),
  );
  assert.notEqual(
    passageAnchor("answer-1", "id"),
    passageAnchor("answer-2", "id"),
  );
  assert.equal(passageAnchor("x", 'a"[1]'), "x-passage-a%22%5B1%5D");
});
test("untrusted links reject executable and relative URLs while keeping timecode anchors", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///secret",
    "/internal",
    "//example.com",
  ])
    assert.equal(safeUrl(url), null);
  assert.equal(
    safeUrl("https://example.com/video?t=40#speaker"),
    "https://example.com/video?t=40#speaker",
  );
});

test("citation text supports arbitrary IDs including brackets, regular-expression punctuation and shared prefixes", () => {
  const text = "First [id[2]]. Next [a+b?] and [a]. Unknown [missing].";
  const segments = citationSegments(text, ["a", "id[2]", "a+b?"]);
  assert.deepEqual(
    segments.filter((part) => part.id).map((part) => part.id),
    ["id[2]", "a+b?", "a"],
  );
  assert.equal(segments.map((part) => part.text).join(""), text);
});
