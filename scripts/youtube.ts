import { exportReviewedTranscript } from "../src/services/youtube/export-reviewed.js";
import { isEvidenceEligible } from "../src/services/youtube/evidence-turns.js";
import { reviewInputHash } from "../src/services/youtube/review-cache.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { DocumentSnapshot } from "../src/contracts.js";
import { createModelClient } from "../src/providers/model-client.js";
import {
  beginApiAttempt,
  finishApiAttempt,
  sanitizeError,
} from "../src/services/measurements/api-calls.js";
import { costOverview } from "../src/services/measurements/receipt.js";
import { beginRun, finishRun } from "../src/services/measurements/runs.js";
import {
  buildDocument,
  discoverOfficialChannel,
  downloadAcceptedAudio,
  importInventory,
  readYouTubeConfig,
  type Inventory,
} from "../src/services/youtube/pipeline.js";
import {
  reviewSpeakers,
  validateReview,
  type SpeakerReview,
} from "../src/services/youtube/review-speakers.js";
import {
  transcribeVideo,
  type TranscriptionMeter,
} from "../src/services/youtube/transcribe-video.js";
import { reconcileSonioxCosts } from "../src/services/youtube/reconcile-soniox-costs.js";
import { renderTranscript } from "../src/services/youtube/render-transcript.js";
import { openDatabase, type Database } from "../src/storage/database.js";

if (existsSync(".env")) loadEnvFile(".env");

const config = readYouTubeConfig();
const flags = parseFlags(process.argv.slice(3));
const command = process.argv[2] ?? "status";
const livePath = flags.live ?? "artifacts/youtube/live-official.jsonl";
const oldManifest = flags["old-manifest"] ?? "";
const oldMetadata = flags["old-metadata"] ?? "data/youtube";
const db = openDatabase(
  flags.db ?? process.env.DB_PATH ?? "data/knowledge.sqlite",
);

try {
  if (command === "discover") {
    await discoverOfficialChannel(livePath);
    print({ status: "completed", livePath });
  } else if (command === "inventory") {
    print(await ensureInventory(true));
  } else if (command === "pilot") {
    const inventory = await ensureInventory(false);
    const selected = config.pilotVideoIds.map((id) =>
      requiredAccepted(inventory, id),
    );
    if (selected.length > config.limits.pilotMaximumVideos)
      throw new Error("Pilot exceeds configured video count");
    if (selected.some((video) => video.durationSeconds === null))
      throw new Error("Pilot contains unknown duration");
    const seconds = selected.reduce(
      (sum, video) => sum + video.durationSeconds!,
      0,
    );
    if (seconds > config.limits.pilotMaximumDurationSeconds)
      throw new Error("Pilot exceeds configured duration");
    await processVideos(
      selected.map((video) => video.id),
      inventory,
      config.limits.pilotBudgetUsd,
    );
  } else if (command === "process" || command === "transcribe") {
    const ids = (flags.ids ?? "").split(",").filter(Boolean);
    if (!ids.length)
      throw new Error(
        "process requires --ids=id1,id2; unreviewed mass processing is disabled",
      );
    const inventory = await ensureInventory(false);
    for (const id of ids) requiredAccepted(inventory, id);
    await processVideos(
      ids,
      inventory,
      config.limits.totalBudgetUsd,
      command === "transcribe",
    );
  } else if (command === "rebuild-documents") {
    const inventory = await ensureInventory(false);
    rebuildDocuments(inventory);
    print({ status: "completed", documents: readDocuments().size });
  } else if (command === "reconcile-costs") {
    print(await reconcileSonioxCosts(db));
    exportLedger(db);
  } else if (command === "export" || command === "status") {
    exportLedger(db);
    print(statusView(db));
  } else {
    throw new Error(
      "Usage: npx tsx scripts/youtube.ts discover|inventory|pilot|process|transcribe --ids=...|rebuild-documents|reconcile-costs|status|export",
    );
  }
} finally {
  db.close();
}

async function ensureInventory(refresh: boolean): Promise<Inventory> {
  if (!existsSync(livePath)) await discoverOfficialChannel(livePath);
  if (!refresh && existsSync(config.paths.inventory))
    return JSON.parse(
      readFileSync(config.paths.inventory, "utf8"),
    ) as Inventory;
  return importInventory({
    oldManifest,
    oldMetadataDirectory: oldMetadata,
    liveFlatList: livePath,
    output: config.paths.inventory,
  });
}

async function processVideos(
  ids: string[],
  inventory: Inventory,
  capUsd: number,
  transcriptionOnly = false,
): Promise<void> {
  const selected = ids.map((id) => requiredAccepted(inventory, id));
  const forecast = selected.reduce((sum, video) => {
    const job = db
      .prepare("SELECT status,data FROM youtube_jobs WHERE video_id=?")
      .get(video.id) as { status: string; data: string } | undefined;
    const reviewPath = `data/youtube/${video.id}.review-v2.json`;
    let reviewExists = false;
    if (job?.status === "completed" && existsSync(reviewPath)) {
      const envelope = JSON.parse(readFileSync(reviewPath, "utf8"));
      const turns = JSON.parse(job.data).turns ?? [];
      const metadata = {
        title: video.title,
        channel: video.channel,
        publishedAt: video.publishedAt,
        description: video.description ?? "",
        recordingDate: video.metadata?.recordingDate ?? null,
      };
      reviewExists = envelope.inputHash === reviewInputHash(turns, metadata);
    }
    const stt =
      job?.status === "completed"
        ? 0
        : ((video.durationSeconds ?? 0) / 3_600) *
          config.limits.sonioxForecastPerHourUsd;
    return sum + stt + (transcriptionOnly || reviewExists ? 0 : 0.15);
  }, 0);
  const alreadyReserved = reservedOrKnown(db);
  if (alreadyReserved + forecast > capUsd) {
    throw new Error(
      `Budget preflight failed: reserved/known $${alreadyReserved.toFixed(4)} + forecast $${forecast.toFixed(4)} > cap $${capUsd.toFixed(2)}`,
    );
  }
  const documents = readDocuments();
  const failures: string[] = [];
  for (const candidate of selected) {
    const runId = beginRun(db, "youtube_video", {
      videoId: candidate.id,
      durationSeconds: candidate.durationSeconds,
    });
    try {
      const audio = await downloadAcceptedAudio(
        candidate,
        config.paths.audioDirectory,
      );
      const job = await transcribeVideo(
        db,
        candidate.id,
        audio,
        sonioxMeter(db, runId, capUsd),
        {
          durationSeconds: candidate.durationSeconds,
        },
      );
      const transcriptDirectory = "artifacts/youtube/transcripts";
      mkdirSync(transcriptDirectory, { recursive: true });
      writeFileSync(
        `${transcriptDirectory}/${candidate.id}.md`,
        renderTranscript(candidate, job.turns ?? []),
      );
      writeFileSync(
        `${transcriptDirectory}/${candidate.id}.json`,
        JSON.stringify(
          {
            videoId: candidate.id,
            sourceUrl: candidate.url,
            title: candidate.title,
            uploadedAt: candidate.publishedAt,
            durationSeconds: candidate.durationSeconds,
            status: "transcribed_unreviewed",
            speakerIdentity: "unverified",
            turns: job.turns ?? [],
          },
          null,
          2,
        ),
      );
      if (transcriptionOnly) {
        annotateRun(db, runId, {
          reviewStatus: "not_requested",
          documentEmitted: false,
          transcriptSaved: true,
        });
        finishRun(db, runId, "completed");
        exportLedger(db);
        console.log(
          `Transcribed ${candidate.id}: ${(job.turns ?? []).length} timed turns`,
        );
        continue;
      }
      const reviewPath = `data/youtube/${candidate.id}.review-v2.json`;
      const reviewMetadata = {
        title: candidate.title,
        channel: candidate.channel,
        publishedAt: candidate.publishedAt,
        description: candidate.description ?? "",
        recordingDate: candidate.metadata?.recordingDate ?? null,
      };
      const inputHash = reviewInputHash(job.turns ?? [], reviewMetadata);
      const cachedReview = existsSync(reviewPath)
        ? JSON.parse(readFileSync(reviewPath, "utf8"))
        : null;
      let review: SpeakerReview;
      if (cachedReview?.inputHash === inputHash) {
        review = cachedReview.review as SpeakerReview;
        validateReview(review, job.turns ?? []);
      } else {
        review = await reviewSpeakers(
          createModelClient(db),
          runId,
          job.turns ?? [],
          reviewMetadata,
        );
        mkdirSync(dirname(reviewPath), { recursive: true });
        writeFileSync(
          reviewPath,
          JSON.stringify(
            { inputHash, model: "gemini-3.8-flash", review },
            null,
            2,
          ),
        );
      }
      exportReviewedTranscript(
        candidate,
        job.turns ?? [],
        review,
        "artifacts/youtube/reviewed",
      );
      if (
        !job.turns?.some((turn, index) =>
          isEvidenceEligible(turn, index, review),
        )
      ) {
        annotateRun(db, runId, {
          reviewStatus: "needs_review",
          documentEmitted: false,
        });
        finishRun(db, runId, "incomplete");
        continue;
      }
      const document = buildDocument(candidate, job.turns ?? [], review);
      documents.set(document.url, document);
      writeDocuments([...documents.values()]);
      finishRun(db, runId, "completed");
    } catch (error) {
      annotateRun(db, runId, {
        failureReason: sanitizeError(error),
        documentEmitted: false,
      });
      finishRun(db, runId, "failed");
      exportLedger(db);
      if (!transcriptionOnly) throw error;
      failures.push(candidate.id);
      console.error(
        `Transcription failed for ${candidate.id}; see persisted run metadata`,
      );
    }
  }
  exportLedger(db);
  print(statusView(db));
  if (failures.length)
    throw new Error(`Incomplete transcription batch: ${failures.join(", ")}`);
}

function sonioxMeter(
  database: Database,
  runId: string,
  capUsd: number,
): TranscriptionMeter {
  return {
    start(metadata) {
      const forecast =
        typeof metadata.forecastCostUsd === "number"
          ? metadata.forecastCostUsd
          : 0;
      return beginApiAttempt(
        database,
        {
          runId,
          stage: "youtube-transcription",
          provider: "soniox",
          model: String(metadata.model ?? "stt-async-v5"),
          attempt: 1,
          operationId: String(metadata.operationId),
          reservationUsd: forecast,
          metadata,
        },
        {
          runUsd: capUsd,
          sessionUsd: capUsd,
          sessionStartedAt: "1970-01-01T00:00:00.000Z",
        },
      );
    },
    finish(attemptId, status, metadata) {
      const row = database
        .prepare("SELECT started_at FROM api_calls WHERE id=?")
        .get(attemptId) as { started_at: string } | undefined;
      finishApiAttempt(database, attemptId, {
        status,
        elapsedMs: row
          ? Math.max(0, Date.now() - Date.parse(row.started_at))
          : 0,
        actualCostUsd: null,
        providerRequestId:
          typeof metadata.providerRequestId === "string"
            ? metadata.providerRequestId
            : null,
        error:
          status === "error"
            ? (metadata.error ??
              "Soniox job failed or submission outcome is ambiguous")
            : undefined,
        metadata,
      });
    },
  };
}

function requiredAccepted(inventory: Inventory, id: string) {
  const candidate = inventory.candidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`Video ${id} is absent from inventory`);
  if (candidate.decision !== "accepted")
    throw new Error(
      `Video ${id} is ${candidate.decision}: ${candidate.reason}`,
    );
  if (
    candidate.durationSeconds === null ||
    !Number.isFinite(candidate.durationSeconds) ||
    candidate.durationSeconds <= 0
  ) {
    throw new Error(
      `Video ${id} has no finite positive duration; refresh metadata and review it before paid processing`,
    );
  }
  return candidate;
}

function reservedOrKnown(database: Database): number {
  const rows = database
    .prepare(
      "SELECT cost_usd, metadata FROM api_calls WHERE stage LIKE 'youtube-%'",
    )
    .all() as Array<{ cost_usd: number | null; metadata: string }>;
  return rows.reduce((sum, row) => {
    if (row.cost_usd !== null) return sum + row.cost_usd;
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    return (
      sum +
      (typeof metadata.reservationUsd === "number"
        ? metadata.reservationUsd
        : 0)
    );
  }, 0);
}

function readDocuments(): Map<string, DocumentSnapshot> {
  if (!existsSync(config.paths.documents)) return new Map();
  const documents = JSON.parse(
    readFileSync(config.paths.documents, "utf8"),
  ) as DocumentSnapshot[];
  return new Map(documents.map((document) => [document.url, document]));
}

function rebuildDocuments(inventory: Inventory): void {
  const reviewDirectories = (flags["review-dirs"] ?? "data/youtube")
    .split(",")
    .filter(Boolean);
  const rows = db
    .prepare(
      "SELECT video_id,data FROM youtube_jobs WHERE status='completed' ORDER BY video_id",
    )
    .all() as Array<{ video_id: string; data: string }>;
  const documents: DocumentSnapshot[] = [];
  for (const row of rows) {
    const candidate = inventory.candidates.find(
      (item) => item.id === row.video_id,
    );
    if (!candidate || candidate.decision !== "accepted") continue;
    const reviewPath = reviewDirectories
      .map((directory) => `${directory}/${row.video_id}.review-v2.json`)
      .find(existsSync);
    if (!reviewPath) continue;
    const cached = JSON.parse(readFileSync(reviewPath, "utf8"));
    const review = cached.review as SpeakerReview;
    const job = JSON.parse(row.data) as {
      turns?: Parameters<typeof buildDocument>[1];
    };
    const expectedHash = reviewInputHash(job.turns ?? [], {
      title: candidate.title,
      channel: candidate.channel,
      publishedAt: candidate.publishedAt,
      description: candidate.description ?? "",
      recordingDate: candidate.metadata?.recordingDate ?? null,
    });
    if (cached.inputHash !== expectedHash) continue;
    validateReview(review, job.turns ?? []);
    if (
      !job.turns?.some((turn, index) => isEvidenceEligible(turn, index, review))
    )
      continue;
    documents.push(buildDocument(candidate, job.turns ?? [], review));
  }
  writeDocuments(documents);
}

function writeDocuments(documents: DocumentSnapshot[]): void {
  mkdirSync(dirname(config.paths.documents), { recursive: true });
  writeFileSync(
    config.paths.documents,
    JSON.stringify(
      documents.sort((a, b) => a.url.localeCompare(b.url)),
      null,
      2,
    ),
  );
}

function exportLedger(database: Database): void {
  const calls = database
    .prepare(
      "SELECT id,run_id,stage,provider,model,started_at,elapsed_ms,input_tokens,output_tokens,cost_usd,status,metadata FROM api_calls WHERE stage LIKE 'youtube-%' ORDER BY started_at,id",
    )
    .all();
  const rows = database
    .prepare("SELECT video_id,status,data FROM youtube_jobs ORDER BY video_id")
    .all() as Array<{ video_id: string; status: string; data: string }>;
  const jobs = rows.map((row) => {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    const turns = Array.isArray(data.turns) ? data.turns : [];
    return {
      videoId: row.video_id,
      status: row.status,
      audioHash: data.audioHash,
      model: data.model,
      fileId: data.fileId,
      transcriptionId: data.transcriptionId,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      turnCount: turns.length,
      providerMetadata: data.providerMetadata,
    };
  });
  mkdirSync("costs/YouTube", { recursive: true });
  writeFileSync(
    "costs/YouTube/ledger.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        overview: youtubeOverview(database),
        calls,
        jobs,
      },
      null,
      2,
    ),
  );
  if (existsSync(config.paths.inventory)) {
    const inventory = JSON.parse(
      readFileSync(config.paths.inventory, "utf8"),
    ) as Inventory;
    writeFileSync(
      "costs/YouTube/inventory-summary.json",
      JSON.stringify(
        {
          generatedAt: inventory.generatedAt,
          counts: inventory.counts,
          acceptedDurationSeconds: inventory.acceptedDurationSeconds,
          unknownAcceptedDurations: inventory.unknownAcceptedDurations,
          sourceCount: inventory.sources.length,
        },
        null,
        2,
      ),
    );
  }
}

function statusView(database: Database): Record<string, unknown> {
  const jobs = database
    .prepare(
      "SELECT status, COUNT(*) count FROM youtube_jobs GROUP BY status ORDER BY status",
    )
    .all();
  return {
    database: resolve(flags.db ?? "data/youtube.sqlite"),
    jobs,
    costs: youtubeOverview(database),
    documents: readDocuments().size,
  };
}

function parseFlags(args: string[]): Record<string, string> {
  return Object.fromEntries(
    args
      .filter((arg) => arg.startsWith("--"))
      .map((arg) => {
        const [key, ...parts] = arg.slice(2).split("=");
        return [key, parts.join("=")];
      }),
  );
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function annotateRun(
  database: Database,
  runId: string,
  values: Record<string, unknown>,
): void {
  const row = database
    .prepare("SELECT metadata FROM runs WHERE id=?")
    .get(runId) as { metadata: string } | undefined;
  if (!row) return;
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  database
    .prepare("UPDATE runs SET metadata=? WHERE id=?")
    .run(JSON.stringify({ ...metadata, ...values }), runId);
}

function youtubeOverview(database: Database) {
  const rows = database
    .prepare(
      "SELECT input_tokens,output_tokens,cost_usd FROM api_calls WHERE stage LIKE 'youtube-%'",
    )
    .all();
  return {
    scope: "YouTube transcription and speaker review",
    calls: rows.length,
    knownCostUsd: rows.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0),
    unknownCalls: rows.filter((row) => row.cost_usd === null).length,
    inputTokens: rows.reduce(
      (sum, row) => sum + Number(row.input_tokens ?? 0),
      0,
    ),
    outputTokens: rows.reduce(
      (sum, row) => sum + Number(row.output_tokens ?? 0),
      0,
    ),
    reservedOrKnownUsd: reservedOrKnown(database),
  };
}
