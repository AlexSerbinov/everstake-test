import { existsSync, readFileSync } from "node:fs";
import { readConfig } from "../../config.js";
import type { DocumentSnapshot, ModelClient } from "../../contracts.js";
import type { Database } from "../../storage/database.js";
import { getSetting, setSetting } from "../../storage/database.js";
import {
  buildDocument,
  downloadAcceptedAudio,
  readYouTubeConfig,
  type Inventory,
} from "../youtube/pipeline.js";
import {
  transcribeVideo,
  type TranscriptionJob,
  type TranscriptionMeter,
} from "../youtube/transcribe-video.js";
import {
  reviewSpeakers,
  validateReview,
  type SpeakerReview,
} from "../youtube/review-speakers.js";
import { reviewInputHash } from "../youtube/review-cache.js";
import { isEvidenceEligible } from "../youtube/evidence-turns.js";
import type { VideoCandidate } from "../youtube/screen-videos.js";
import {
  beginApiAttempt,
  finishApiAttempt,
} from "../measurements/api-calls.js";
import {
  discoverUpdateVideos,
  completeVideoMetadata,
} from "./discover-videos.js";

interface VideoUpdate {
  candidate: VideoCandidate;
  status: "pending" | "ready" | "needs_review" | "excluded";
  document?: DocumentSnapshot;
  review?: SpeakerReview;
  reviewHash?: string;
  reason?: string;
}
export interface VideoRefreshResult {
  documents: DocumentSnapshot[];
  discovered: number;
  skipped: number;
  processed: number;
  pending: number;
  needsReview: number;
  excluded: number;
}
export async function refreshVideos(
  db: Database,
  model: ModelClient,
  runId: string,
  maximum: number,
  progress: (phase: string) => void,
  dependencies: {
    discover?: () => Promise<VideoCandidate[]>;
    metadata?: typeof completeVideoMetadata;
    process?: (candidate: VideoCandidate) => Promise<DocumentSnapshot | null>;
    knownIds?: string[];
  } = {},
): Promise<VideoRefreshResult> {
  const config = readYouTubeConfig();
  if (!getSetting(db, "update_video_budget_start"))
    setSetting(db, "update_video_budget_start", new Date().toISOString());
  const inventory = existsSync(config.paths.inventory)
    ? (JSON.parse(readFileSync(config.paths.inventory, "utf8")) as Inventory)
    : null;
  const known = new Set(
    dependencies.knownIds ?? inventory?.candidates.map((v) => v.id) ?? [],
  );
  for (const row of db.prepare("SELECT video_id FROM youtube_jobs").all())
    known.add(String(row.video_id));
  for (const row of db
    .prepare(
      "SELECT snapshot FROM documents WHERE json_extract(snapshot,'$.kind')='youtube'",
    )
    .all()) {
    const d = JSON.parse(String(row.snapshot));
    if (d.metadata?.videoId) known.add(d.metadata.videoId);
  }
  const read = (id: string): VideoUpdate | null =>
    JSON.parse(getSetting(db, `update_video:${id}`, "null"));
  const save = (v: VideoUpdate) =>
    setSetting(db, `update_video:${v.candidate.id}`, JSON.stringify(v));
  progress("Discovering new video IDs");
  const discovered = await (dependencies.discover ?? discoverUpdateVideos)();
  let skipped = 0;
  for (const candidate of discovered) {
    if (read(candidate.id)) continue;
    if (known.has(candidate.id)) {
      skipped++;
      continue;
    }
    save({ candidate, status: "pending" });
  }
  const videos = () =>
    db
      .prepare("SELECT value FROM settings WHERE key LIKE 'update_video:%'")
      .all()
      .map((r) => JSON.parse(String(r.value)) as VideoUpdate);
  let processed = 0;
  for (const state of videos()
    .filter((v) => v.status === "pending")
    .slice(0, maximum)) {
    progress(`Checking video ${state.candidate.id}`);
    const candidate = await (dependencies.metadata ?? completeVideoMetadata)(
      state.candidate,
    );
    state.candidate = candidate;
    if (candidate.decision !== "accepted" || !candidate.durationSeconds) {
      state.status =
        candidate.decision === "excluded" ? "excluded" : "needs_review";
      state.reason = candidate.reason;
      save(state);
      continue;
    }
    progress(`Transcribing and reviewing ${candidate.id}`);
    const document = dependencies.process
      ? await dependencies.process(candidate)
      : await processVideo(state);
    state.status = document ? "ready" : "needs_review";
    if (document) state.document = document;
    else state.reason = "No eligible company testimony after speaker review";
    save(state);
    processed++;
  }
  const all = videos();
  return {
    documents: all.flatMap((v) => (v.document ? [v.document] : [])),
    discovered: discovered.length,
    skipped,
    processed,
    pending: all.filter((v) => v.status === "pending").length,
    needsReview: all.filter((v) => v.status === "needs_review").length,
    excluded: all.filter((v) => v.status === "excluded").length,
  };

  async function processVideo(
    state: VideoUpdate,
  ): Promise<DocumentSnapshot | null> {
    const candidate = state.candidate;
    const row = db
      .prepare("SELECT data FROM youtube_jobs WHERE video_id=?")
      .get(candidate.id);
    const cached = row
      ? (JSON.parse(String(row.data)) as TranscriptionJob)
      : null;
    const meter: TranscriptionMeter = {
      start(metadata) {
        return beginApiAttempt(
          db,
          {
            runId,
            stage: "youtube-transcription",
            provider: "soniox",
            model: String(metadata.model),
            attempt: 1,
            operationId: String(metadata.operationId),
            reservationUsd: Number(metadata.forecastCostUsd ?? 0),
            metadata,
          },
          {
            runUsd: config.limits.totalBudgetUsd,
            sessionUsd: readConfig<{ maxSessionCostUsd: number }>("policy")
              .maxSessionCostUsd,
            sessionStartedAt: getSetting(
              db,
              "update_video_budget_start",
              new Date().toISOString(),
            ),
          },
        );
      },
      finish(id, status, metadata) {
        const started = db
          .prepare("SELECT started_at FROM api_calls WHERE id=?")
          .get(id);
        finishApiAttempt(db, id, {
          status,
          elapsedMs: started
            ? Date.now() - Date.parse(String(started.started_at))
            : 0,
          actualCostUsd: null,
          metadata,
        });
      },
    };
    // Completed STT is read directly: no download, upload or model-change retranscription.
    const job =
      cached?.status === "completed"
        ? cached
        : await transcribeVideo(
            db,
            candidate.id,
            await downloadAcceptedAudio(candidate, "data/updates/audio"),
            meter,
            {
              durationSeconds: candidate.durationSeconds,
              artifactDirectory: "data/updates/transcripts",
            },
          );
    const turns = job.turns ?? [];
    const metadata = {
      title: candidate.title,
      channel: candidate.channel,
      publishedAt: candidate.publishedAt,
      description: candidate.description ?? "",
      recordingDate: candidate.metadata?.recordingDate ?? null,
    };
    const hash = reviewInputHash(turns, metadata);
    const review =
      state.reviewHash === hash && state.review
        ? state.review
        : await reviewSpeakers(model, runId, turns, metadata);
    validateReview(review, turns);
    state.review = review;
    state.reviewHash = hash;
    save(state);
    if (!turns.some((turn, i) => isEvidenceEligible(turn, i, review)))
      return null;
    return buildDocument(candidate, turns, review);
  }
}
