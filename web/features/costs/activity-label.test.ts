import { test } from "node:test";
import assert from "node:assert/strict";
import { activityTitle } from "./activity-label.js";

test("redacted question metadata keeps runs distinguishable without inventing question text", () => {
  assert.equal(
    activityTitle("query", null, "12345678-abcd"),
    "Question · 12345678",
  );
  assert.equal(
    activityTitle("query", "A published question", "12345678-abcd"),
    "A published question",
  );
  assert.equal(
    activityTitle("index", null, "abcdefgh-rest"),
    "Search preparation · abcdefgh",
  );
});
