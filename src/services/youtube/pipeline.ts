import { sanitizeDocument } from "../evidence/sanitize-document.js";
import { isEvidenceEligible } from "./evidence-turns.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import type { DocumentSnapshot } from "../../contracts.js";
import type { SpeakerReview } from "./review-speakers.js";
import {
  screenVideo,
  type ScreeningPolicy,
  type VideoCandidate,
} from "./screen-videos.js";
import { formatTimestamp, type Turn } from "./turns.js";

const exec = promisify(execFile);

export interface YouTubeConfig {
  officialChannel: { handle: string; id: string };
  screening: Omit<ScreeningPolicy, "officialChannelIds">;
  pilotVideoIds: string[];
  paths: { inventory: string; documents: string; audioDirectory: string };
  limits: {
    pilotMaximumVideos: number;
    pilotMaximumDurationSeconds: number;
    pilotBudgetUsd: number;
    totalBudgetUsd: number;
    sonioxForecastPerHourUsd: number;
  };
}

export interface Inventory {
  generatedAt: string;
  sources: Array<{
    kind: string;
    location: string;
    checkedAt: string;
    note: string;
  }>;
  counts: Record<string, number>;
  acceptedDurationSeconds: number;
  unknownAcceptedDurations: number;
  candidates: VideoCandidate[];
}

export function readYouTubeConfig(): YouTubeConfig {
  return parse(readFileSync("config/youtube.yaml", "utf8")) as YouTubeConfig;
}

export function importInventory(options: {
  oldManifest: string;
  oldMetadataDirectory: string;
  liveFlatList: string;
  output: string;
  checkedAt?: string;
}): Inventory {
  const config = readYouTubeConfig();
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const merged = new Map<string, Omit<VideoCandidate, "decision" | "reason">>();
  const add = (
    input: Omit<VideoCandidate, "decision" | "reason">,
    evidence: Record<string, unknown>,
  ): void => {
    const prior = merged.get(input.id);
    const provenance = [...(prior?.provenance ?? []), evidence];
    merged.set(input.id, {
      ...(prior ?? input),
      ...Object.fromEntries(
        Object.entries(input).filter(
          ([, value]) => value !== "" && value !== null,
        ),
      ),
      publishedAt: input.publishedAt ?? prior?.publishedAt ?? null,
      durationSeconds: input.durationSeconds ?? prior?.durationSeconds ?? null,
      provenance,
      metadata: {
        ...prior?.metadata,
        ...input.metadata,
        cacheOnly: true,
        requiresFreshAudio: true,
      },
    });
  };

  if (existsSync(options.output)) {
    const current = JSON.parse(
      readFileSync(options.output, "utf8"),
    ) as Inventory;
    for (const { decision, reason, ...candidate } of current.candidates)
      add(candidate, { kind: "previous-inventory", checkedAt });
  }
  const old = (
    options.oldManifest && existsSync(options.oldManifest)
      ? JSON.parse(readFileSync(options.oldManifest, "utf8"))
      : {}
  ) as {
    ts?: string;
    candidates?: Array<Record<string, unknown>>;
  };
  for (const item of old.candidates ?? []) {
    const id = String(item.id ?? "");
    if (!/^[\w-]{11}$/.test(id)) continue;
    const infoPath = join(options.oldMetadataDirectory, `${id}.info.json`);
    const info = existsSync(infoPath)
      ? (JSON.parse(readFileSync(infoPath, "utf8")) as Record<string, unknown>)
      : {};
    add(candidateFromRecords(id, item, info), {
      kind: "legacy-discovery-manifest",
      location: options.oldManifest,
      discoveredAt: old.ts ?? null,
      priorOutcome: item.outcome ?? null,
    });
    if (existsSync(infoPath)) {
      const current = merged.get(id)!;
      remember(current, infoPath);
    }
  }

  for (const line of readFileSync(options.liveFlatList, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)) {
    const item = JSON.parse(line) as Record<string, unknown>;
    const id = String(item.id ?? "");
    if (!/^[\w-]{11}$/.test(id)) continue;
    const candidate = candidateFromRecords(id, item, {});
    candidate.channelId = config.officialChannel.id;
    candidate.channel ||=
      stringValue(item.channel ?? item.uploader) || "Everstake";
    add(candidate, {
      kind: "live-official-channel-flat-list",
      location: options.liveFlatList,
      checkedAt,
      channelHandle: config.officialChannel.handle,
    });
  }

  const policy: ScreeningPolicy = {
    ...config.screening,
    officialChannelIds: [config.officialChannel.id],
  };
  const candidates = [...merged.values()]
    .map((candidate) => screenVideo(candidate, policy))
    .sort(
      (left, right) =>
        left.publishedAt?.localeCompare(right.publishedAt ?? "") ||
        left.id.localeCompare(right.id),
    );
  const counts = Object.fromEntries(
    ["accepted", "needs_review", "excluded"].map((decision) => [
      decision,
      candidates.filter((candidate) => candidate.decision === decision).length,
    ]),
  );
  const accepted = candidates.filter(
    (candidate) => candidate.decision === "accepted",
  );
  const inventory: Inventory = {
    generatedAt: checkedAt,
    sources: [
      {
        kind: "legacy-manifest",
        location: options.oldManifest,
        checkedAt,
        note: "Imported as candidate provenance and re-screened; prior outcomes were not silently accepted.",
      },
      {
        kind: "live-channel-flat-list",
        location: options.liveFlatList,
        checkedAt,
        note: "Fresh metadata inventory; full metadata and audio are fetched only for accepted processing.",
      },
    ],
    counts: { discovered: candidates.length, ...counts },
    acceptedDurationSeconds: accepted.reduce(
      (sum, candidate) => sum + (candidate.durationSeconds ?? 0),
      0,
    ),
    unknownAcceptedDurations: accepted.filter(
      (candidate) => candidate.durationSeconds === null,
    ).length,
    candidates,
  };
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, JSON.stringify(inventory, null, 2));
  return inventory;
}

function candidateFromRecords(
  id: string,
  item: Record<string, unknown>,
  info: Record<string, unknown>,
): Omit<VideoCandidate, "decision" | "reason"> {
  const uploadDate = stringValue(info.upload_date ?? item.upload_date);
  const channelId = stringValue(info.channel_id ?? item.channel_id);
  return {
    id,
    title: stringValue(info.title ?? item.title),
    description: stringValue(info.description ?? item.description),
    channelId,
    channel: stringValue(info.channel ?? info.uploader ?? item.channel),
    url: `https://www.youtube.com/watch?v=${id}`,
    publishedAt: uploadDate
      ? /^\d{8}$/.test(uploadDate)
        ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6)}`
        : uploadDate
      : null,
    durationSeconds: numberValue(
      info.duration ?? item.duration_sec ?? item.duration,
    ),
    provenance: [],
    metadata: {
      captionLanguages: Object.keys(recordValue(info.subtitles)),
      automaticCaptionLanguages: Object.keys(
        recordValue(info.automatic_captions),
      ),
      recordingDate: stringValue(info.release_date) || null,
    },
  };
}

function remember(
  current: Omit<VideoCandidate, "decision" | "reason">,
  infoPath: string,
): void {
  current.provenance = [
    ...(current.provenance ?? []),
    { kind: "legacy-yt-dlp-info", location: infoPath },
  ];
}

export async function discoverOfficialChannel(output: string): Promise<void> {
  const config = readYouTubeConfig();
  mkdirSync(dirname(output), { recursive: true });
  const binary = process.env.YT_DLP_BIN ?? "yt-dlp";
  const { stdout } = await exec(
    binary,
    [
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      config.officialChannel.handle,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  writeFileSync(output, stdout);
}

export async function downloadAcceptedAudio(
  candidate: VideoCandidate,
  outputDirectory: string,
): Promise<string> {
  if (candidate.decision !== "accepted")
    throw new Error(
      `Refusing paid processing for ${candidate.id}: ${candidate.decision}`,
    );
  mkdirSync(outputDirectory, { recursive: true });
  const output = join(outputDirectory, `${candidate.id}.m4a`);
  if (existsSync(output)) return output;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "-f",
    "bestaudio[ext=m4a]/bestaudio",
    "-o",
    output,
  ];
  if (process.env.YT_PROXY) args.push("--proxy", process.env.YT_PROXY);
  const cookieCopy = process.env.YT_COOKIES_FILE
    ? join(outputDirectory, `.cookies-${process.pid}.txt`)
    : null;
  if (cookieCopy) {
    copyFileSync(process.env.YT_COOKIES_FILE!, cookieCopy);
    args.push("--cookies", cookieCopy);
  }
  if (process.env.YT_JS_RUNTIMES)
    args.push("--js-runtimes", process.env.YT_JS_RUNTIMES);
  args.push(candidate.url);
  try {
    await exec(process.env.YT_DLP_BIN ?? "yt-dlp", args, {
      timeout: 30 * 60 * 1_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    if (cookieCopy && existsSync(cookieCopy)) unlinkSync(cookieCopy);
  }
  if (!existsSync(output)) throw new Error(`yt-dlp did not create ${output}`);
  return output;
}

export function buildDocument(
  candidate: VideoCandidate,
  turns: Turn[],
  review: SpeakerReview,
  fetchedAt = new Date().toISOString(),
): DocumentSnapshot {
  if (candidate.decision !== "accepted")
    throw new Error(`Cannot emit excluded video ${candidate.id}`);
  const speakers = new Map(
    review.speakers.map((speaker) => [speaker.label, speaker]),
  );
  const lines = turns.flatMap((turn, index) => {
    if (!isEvidenceEligible(turn, index, review)) return [];
    const reviewed = turn.speaker === null ? null : speakers.get(turn.speaker);
    const identity =
      reviewed?.name ??
      (turn.speaker === null ? "Unknown speaker" : `Speaker ${turn.speaker}`);
    const role = reviewed?.roleAtRecording
      ? `, ${reviewed.roleAtRecording}`
      : "";
    const time = formatTimestamp(turn.startMs) ?? "time unknown";
    const safeText = sanitizeDocument(turn.text).text;
    if (!safeText) return [];
    return [
      `[${time}] ${identity}${role} (company participant; testimony at recording): ${safeText}`,
    ];
  });
  const text = lines.join("\n");
  if (!text.trim())
    throw new Error("No eligible company testimony after speaker review");
  const contentHash = createHash("sha256").update(text).digest("hex");
  const recordedAt =
    typeof candidate.metadata?.recordingDate === "string" &&
    candidate.metadata.recordingDate
      ? candidate.metadata.recordingDate
      : null;
  const config = readYouTubeConfig();
  const verifiedCompanySpeakers = review.speakers.filter(
    (speaker) =>
      speaker.name &&
      speaker.roleAtRecording &&
      (speaker.evidenceTurnIndexes.length > 0 ||
        (speaker.introductionEvidence?.length ?? 0) > 0) &&
      (speaker.participantType === "employee" ||
        config.screening.companyTerms.some((term) =>
          speaker
            .roleAtRecording!.toLocaleLowerCase("en")
            .includes(term.toLocaleLowerCase("en")),
        )),
  );
  const officialPublisher = candidate.channelId === config.officialChannel.id;
  const interviewAuthority =
    !officialPublisher &&
    review.status === "reviewed" &&
    verifiedCompanySpeakers.length > 0;
  const primarySpeaker =
    verifiedCompanySpeakers.length === 1 ? verifiedCompanySpeakers[0] : null;
  return {
    id: `youtube:${candidate.id}:${contentHash.slice(0, 16)}`,
    url: candidate.url,
    canonicalUrl: candidate.url,
    title: candidate.title,
    publisher: candidate.channel || "YouTube",
    authority: officialPublisher ? 1 : interviewAuthority ? 2 : 3,
    kind: "youtube",
    text,
    contentHash,
    fetchedAt,
    publishedAt: candidate.publishedAt,
    updatedAt: null,
    dateEvidence: candidate.publishedAt
      ? `publishedAt: youtube upload date; recordedAt: ${recordedAt ?? "unknown"}`
      : `publishedAt: unknown; recordedAt: ${recordedAt ?? "unknown"}`,
    duplicateOf: null,
    revision: `soniox:${process.env.SONIOX_MODEL ?? "stt-async-v5"}:speaker-review:${contentHash.slice(0, 12)}`,
    metadata: {
      sourceId: "youtube-inventory",
      videoId: candidate.id,
      ...(primarySpeaker
        ? {
            speaker: primarySpeaker.label,
            speakerName: primarySpeaker.name,
            roleAtRecording: primarySpeaker.roleAtRecording,
          }
        : {}),
      speakerStatus: officialPublisher
        ? primarySpeaker
          ? "verified_company_participant"
          : "official_publisher_speaker_unidentified"
        : interviewAuthority
          ? "verified_company_participant_in_third_party_interview"
          : "unverified",
      reviewStatus: review.status,
      recordedAt,
      refreshStatus: "transcribed",
      freshnessNote:
        `${candidate.publishedAt ? "publishedAt is the YouTube upload date" : "upload date is unknown"}; recording date is retained only when separately present. ${interviewAuthority ? "Tier 2 applies to the named Everstake participant’s statements; interviewer questions are context, not first-party factual evidence." : ""}`.trim(),
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
