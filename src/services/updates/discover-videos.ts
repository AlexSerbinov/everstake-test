import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConfig } from "../../config.js";
import { readYouTubeConfig } from "../youtube/pipeline.js";
import { screenVideo, type VideoCandidate } from "../youtube/screen-videos.js";
const exec = promisify(execFile);

export function videoCandidate(
  record: Record<string, unknown>,
  location: string,
): VideoCandidate {
  const config = readYouTubeConfig();
  const id = String(record.id ?? "");
  if (!/^[\w-]{11}$/.test(id)) throw new Error("Invalid discovery video ID");
  const rawDate = String(record.upload_date ?? "");
  return screenVideo(
    {
      id,
      title: String(record.title ?? ""),
      description: String(record.description ?? ""),
      channelId: String(record.channel_id ?? ""),
      channel: String(record.channel ?? record.uploader ?? ""),
      url: `https://www.youtube.com/watch?v=${id}`,
      publishedAt: /^\d{8}$/.test(rawDate)
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`
        : null,
      durationSeconds:
        typeof record.duration === "number" &&
        Number.isFinite(record.duration) &&
        record.duration > 0
          ? record.duration
          : null,
      provenance: [
        {
          kind: "refresh-discovery",
          location,
          checkedAt: new Date().toISOString(),
        },
      ],
    },
    { ...config.screening, officialChannelIds: [config.officialChannel.id] },
  );
}
async function metadata(args: string[]) {
  const { stdout } = await exec(
    process.env.YT_DLP_BIN ?? "yt-dlp",
    [
      "--ignore-config",
      "--skip-download",
      "--dump-json",
      "--no-warnings",
      ...args,
    ],
    { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
export async function discoverUpdateVideos(): Promise<VideoCandidate[]> {
  const config = readYouTubeConfig();
  const discovery = readConfig<{
    youtubeSearches: string[];
    maximumEntriesPerLocation: number;
  }>("update-discovery");
  const candidates = new Map<string, VideoCandidate>();
  for (const location of [
    config.officialChannel.handle,
    ...discovery.youtubeSearches,
  ]) {
    const rows = await metadata([
      "--flat-playlist",
      "--playlist-end",
      String(discovery.maximumEntriesPerLocation),
      "--",
      location,
    ]);
    for (const row of rows) {
      if (!/^[\w-]{11}$/.test(String(row.id ?? ""))) continue;
      const candidate = videoCandidate(row, location);
      candidates.set(candidate.id, candidate);
    }
  }
  return [...candidates.values()];
}
export async function completeVideoMetadata(
  candidate: VideoCandidate,
): Promise<VideoCandidate> {
  const rows = await metadata(["--no-playlist", "--", candidate.url]);
  if (rows.length !== 1 || rows[0].id !== candidate.id)
    throw new Error("Video metadata ID mismatch");
  return videoCandidate(rows[0], candidate.url);
}
