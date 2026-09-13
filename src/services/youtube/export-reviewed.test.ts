import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportReviewedTranscript,
  exportReviewedTranscriptIndex,
} from "./export-reviewed.js";
import type { SpeakerReview } from "./review-speakers.js";
import type { Turn } from "./turns.js";

const turns: Turn[] = [
  { speaker: "1", startMs: 0, endMs: 1000, text: "You support 2000 chains?" },
  {
    speaker: "2",
    startMs: 1000,
    endMs: 2000,
    text: "No, we support 130 chains.",
  },
  { speaker: "2", startMs: 2000, endMs: 3000, text: "An unsupported aside." },
  { speaker: null, startMs: null, endMs: null, text: "Unknown voice." },
];
const review: SpeakerReview & { excludedTurnIndexes: number[] } = {
  status: "reviewed",
  suspiciousIntervals: [],
  limitations: ["Roles apply at recording."],
  excludedTurnIndexes: [2],
  speakers: [
    {
      label: "1",
      name: "Host",
      roleAtRecording: "Host",
      participantType: "interviewer",
      evidenceTurnIndexes: [0],
      reason: "Introduces guest.",
    },
    {
      label: "2",
      name: "Guest",
      roleAtRecording: "COO",
      participantType: "employee",
      evidenceTurnIndexes: [1],
      reason: "Introduces role.",
    },
  ],
};

test("readable exports preserve corrections and raw labels while only employee evidence is eligible", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewed-export-"));
  try {
    const result = exportReviewedTranscript(
      {
        id: "abcdefghijk",
        title: "Інтерв’ю / Company strategy",
        url: "https://youtu.be/abcdefghijk",
        publishedAt: "2025-01-02",
      },
      turns,
      review,
      dir,
    );
    assert.match(
      result.basename,
      /^2025-01-02-coo-guest-інтерв-ю-company-strategy--abcdefghijk$/,
    );
    const json = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.deepEqual(
      json.turns.map(
        (turn: { evidenceEligible: boolean }) => turn.evidenceEligible,
      ),
      [false, true, false, false],
    );
    assert.deepEqual(
      json.turns.map((turn: Turn) => turn.text),
      turns.map((turn) => turn.text),
    );
    assert.equal(json.turns[1].speaker, "2");
    assert.equal(json.turns[1].roleAtRecording, "COO");
    assert.equal(json.turns[3].speakerName, null);
    const markdown = readFileSync(result.markdownPath, "utf8");
    assert.match(markdown, /Guest · COO · employee/);
    assert.match(markdown, /Unknown person/);
    assert.match(markdown, /https:\/\/youtu.be\/abcdefghijk\?t=1/);
    assert.ok(markdown.indexOf("2000") < markdown.indexOf("130"));
    const index = readFileSync(
      exportReviewedTranscriptIndex([result], dir),
      "utf8",
    );
    assert.ok(index.includes(encodeURIComponent(result.basename) + ".md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreviewed identity and suspicious turns never become eligible in exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewed-export-"));
  try {
    const result = exportReviewedTranscript(
      {
        id: "abcdefghijk",
        title: "Interview",
        url: "https://youtube.com/watch?v=abcdefghijk",
        publishedAt: null,
      },
      turns,
      {
        ...review,
        status: "needs_review",
        suspiciousIntervals: [
          { fromTurn: 1, toTurn: 1, reason: "Label swapped." },
        ],
      },
      dir,
    );
    const json = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.ok(
      json.turns.every(
        (turn: { evidenceEligible: boolean }) => !turn.evidenceEligible,
      ),
    );
    assert.match(readFileSync(result.markdownPath, "utf8"), /Label swapped/);
    assert.match(result.basename, /^date-unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("display titles put dated role and surname before given name and topic", async () => {
  const { reviewedVideoTitle } = await import("./transcript-title.js");
  const named = {
    ...review,
    speakers: [
      {
        ...review.speakers[1]!,
        name: "Bohdan Opryshko",
        roleAtRecording: "Co-founder and COO at Everstake",
      },
    ],
  };
  assert.equal(
    reviewedVideoTitle(
      { title: "Company history", publishedAt: "2026-04-23" },
      named,
    ),
    "2026-04-23 — COO — Opryshko Bohdan — Company history",
  );
  const uncertain = {
    ...named,
    speakers: [{ ...named.speakers[0]!, roleAtRecording: null }],
  };
  assert.match(
    reviewedVideoTitle({ title: "Interview", publishedAt: null }, uncertain),
    /role-unconfirmed — Opryshko Bohdan/,
  );
});
