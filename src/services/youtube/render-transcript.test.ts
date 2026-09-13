import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTranscript } from "./render-transcript.js";

test("transcript export keeps unknown identity and time explicit, preserving questions and corrections", () => {
  const output = renderTranscript(
    {
      title: "Interview",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      publishedAt: null,
    },
    [
      {
        speaker: "1",
        startMs: 65000,
        endMs: 68000,
        text: "Do you support 2700 networks?",
      },
      {
        speaker: "2",
        startMs: 68000,
        endMs: 72000,
        text: "No, that number is incorrect.",
      },
      { speaker: null, startMs: null, endMs: null, text: "Unassigned speech." },
    ],
  );
  assert.match(output, /transcribed, not reviewed/);
  assert.match(output, /Uploaded: unknown/);
  assert.match(output, /&t=65/);
  assert.match(output, /Speaker unknown/);
  assert.match(output, /unknown time/);
  assert.ok(output.indexOf("2700") < output.indexOf("incorrect"));
});
