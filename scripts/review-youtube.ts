import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { sanitizeError } from "../src/services/measurements/api-calls.js";
import { openDatabase } from "../src/storage/database.js";
import { createModelClient } from "../src/providers/model-client.js";
import { beginRun, finishRun } from "../src/services/measurements/runs.js";
import {
  reviewSpeakers,
  validateReview,
  type SpeakerReview,
} from "../src/services/youtube/review-speakers.js";
import {
  exportReviewedTranscript,
  exportReviewedTranscriptIndex,
  type ReviewedTranscriptExport,
} from "../src/services/youtube/export-reviewed.js";
import {
  buildDocument,
  type Inventory,
} from "../src/services/youtube/pipeline.js";
import { isEvidenceEligible } from "../src/services/youtube/evidence-turns.js";
import type { Turn } from "../src/services/youtube/turns.js";
import type { DocumentSnapshot } from "../src/contracts.js";

if (existsSync(".env")) loadEnvFile(".env");
const flags = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const ids = (flags.ids ?? "").split(",").filter(Boolean);
if (!ids.length || ids.some((id) => !/^[\w-]{11}$/.test(id)))
  throw new Error("Provide --ids with valid YouTube IDs");
const db = openDatabase(flags.db ?? "data/youtube-reviews-2026-09-13.sqlite");
const inventory: Inventory = JSON.parse(
  readFileSync("artifacts/youtube/inventory.json", "utf8"),
);
const directory = "artifacts/youtube/reviewed";
mkdirSync(directory, { recursive: true });
const documents: DocumentSnapshot[] = existsSync(`${directory}/documents.json`)
  ? JSON.parse(readFileSync(`${directory}/documents.json`, "utf8")).filter(
      (d: DocumentSnapshot) => !ids.includes(String(d.metadata.videoId)),
    )
  : [];
const results: Record<string, unknown>[] = existsSync(
  `${directory}/manifest.json`,
)
  ? JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")).filter(
      (r: Record<string, unknown>) => !ids.includes(String(r.videoId)),
    )
  : [];
const exports: ReviewedTranscriptExport[] = results.filter(
  (r) => r.basename,
) as unknown as ReviewedTranscriptExport[];
const model = createModelClient(db);
try {
  for (const id of ids) {
    const video = inventory.candidates.find((v) => v.id === id);
    if (!video || video.decision !== "accepted")
      throw new Error(`Video ${id} is not approved`);
    const jobPath = `data/youtube/${id}.job.json`;
    const transcriptPath = existsSync(jobPath)
      ? jobPath
      : `artifacts/youtube/transcripts/${id}.json`;
    const job = JSON.parse(readFileSync(transcriptPath, "utf8")) as {
      turns: Turn[];
    };
    if (!job.turns?.length)
      throw new Error(`Missing cached transcript for ${id}`);
    const metadata = {
      title: video.title,
      channel: video.channel,
      publishedAt: video.publishedAt,
      description: video.description ?? "",
      recordingDate: video.metadata?.recordingDate ?? null,
    };
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          turns: job.turns,
          metadata,
          model: "gemini-3.8-flash",
          prompt: readFileSync("assistant/prompts/speaker-review.md", "utf8"),
        }),
      )
      .digest("hex");
    const cache = `data/youtube/${id}.review-v2.json`;
    let runId: string | undefined;
    try {
      let review: SpeakerReview;
      const cached = existsSync(cache)
        ? JSON.parse(readFileSync(cache, "utf8"))
        : null;
      if (cached?.inputHash === hash) review = cached.review;
      else {
        runId = beginRun(db, "youtube_speaker_review", {
          videoId: id,
          inputHash: hash,
        });
        review = await reviewSpeakers(model, runId, job.turns, metadata);
        writeFileSync(
          cache,
          JSON.stringify(
            { inputHash: hash, model: "gemini-3.8-flash", review },
            null,
            2,
          ),
        );
      }
      validateReview(review, job.turns);
      const exported = exportReviewedTranscript(
        video,
        job.turns,
        review,
        directory,
      );
      exports.push(exported);
      exportReviewedTranscriptIndex(exports, directory);
      const eligible = job.turns.filter((t, i) =>
        isEvidenceEligible(t, i, review),
      ).length;
      if (eligible) documents.push(buildDocument(video, job.turns, review));
      if (runId)
        finishRun(
          db,
          runId,
          review.status === "reviewed" ? "completed" : "incomplete",
        );
      results.push({
        videoId: id,
        title: video.title,
        status: review.status,
        eligibleTurns: eligible,
        ...exported,
      });
      console.log(
        JSON.stringify({
          videoId: id,
          status: review.status,
          eligibleTurns: eligible,
          speakers: review.speakers.map((s) => ({
            name: s.name,
            role: s.roleAtRecording,
            type: s.participantType,
          })),
        }),
      );
    } catch (error) {
      if (runId) finishRun(db, runId, "failed");
      results.push({
        videoId: id,
        status: "failed",
        error: sanitizeError(error),
      });
      console.error(`Review failed for ${id}: ${sanitizeError(error)}`);
    }
    writeFileSync(
      `${directory}/manifest.json`,
      JSON.stringify(results, null, 2),
    );
    writeFileSync(
      `${directory}/documents.json`,
      JSON.stringify(documents, null, 2),
    );
  }
} finally {
  db.close();
}
if (results.some((r) => r.status === "failed")) process.exitCode = 1;
