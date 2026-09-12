// Pipeline: crawl (one of the five source kinds in crawler.ts).
// Turns a YouTube URL into a text document by pulling the subtitle track with yt-dlp. Nothing
// here transcribes audio and nothing here downloads video.
//
// Why the auto-generated subtitles: none of these videos carry human captions, but YouTube
// publishes an ASR track for all of them, so the transcription cost of the whole video corpus is
// zero (REPORT §2.6). The price is accuracy — ASR mangles names and tickers, and "Everstake" is
// one vowel away from the unrelated "EverRise" token. That is why every video document is
// **tier 3** (authority 0.5 in ranking) and is never allowed to be the sole evidence behind a
// fact. Raising that tier would let a mis-heard number or name become an answer.
//
// yt-dlp is an external binary. If it is missing, rate-limited, or a video has no subtitles, the
// video is dropped with a recorded reason and the rest of the crawl is unaffected.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, getConfig } from "../config.js";

const exec = promisify(execFile);

/** Metadata and .vtt files land here and are reused on re-crawl, so a re-run costs no downloads. */
const YT_DIR = path.join(DATA_DIR, "youtube");

/** Listing a channel only prints video ids — no media. Hand-tuned ceiling for a slow response. */
const CHANNEL_LIST_TIMEOUT_MS = 120_000;

/** Per video: metadata JSON + subtitle file, still no media. Hand-tuned; nothing measures it. */
const VIDEO_FETCH_TIMEOUT_MS = 180_000;

/** yt-dlp failures print a multi-line dump; the first line carries the cause, the rest is noise. */
const ERROR_EXCERPT_CHARS = 200;

export interface VideoDoc {
  url: string;
  id: string;
  title: string;
  channel: string;
  /** From yt-dlp's `upload_date`; the only date YouTube gives us for a video. */
  uploadDate: string | null;
  durationSec: number;
  /** The flattened subtitle track — empty when the video has no usable captions. */
  text: string;
}

/**
 * Newest `limit` video URLs of a channel. `--flat-playlist` stops yt-dlp from opening each video
 * (one request instead of N), which is why this returns ids we later resolve one by one.
 *
 * Only the official channel is ever passed in: a YouTube search for "Everstake" also returns
 * EverRise token videos, the exact brand confusion the corpus is meant to survive (REPORT §2.6).
 */
export async function listChannelVideos(channelUrl: string, limit: number): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "yt-dlp",
      ["--flat-playlist", "--playlist-end", String(limit), "--print", "%(id)s", channelUrl],
      { timeout: CHANNEL_LIST_TIMEOUT_MS },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((videoId) => `https://www.youtube.com/watch?v=${videoId}`);
  } catch (error: any) {
    // A missing binary or a throttled channel costs us the video source, not the crawl.
    console.warn("  yt-dlp channel listing failed:", errorExcerpt(error));
    return [];
  }
}

/**
 * One video → a VideoDoc, or null when yt-dlp could not produce metadata at all. A video that
 * exists but has no subtitle track comes back with `text: ""`; the caller drops it as
 * "no subtitles" so the reason survives in the documents table.
 */
export async function fetchVideo(url: string): Promise<VideoDoc | null> {
  fs.mkdirSync(YT_DIR, { recursive: true });
  // "…/watch?v=ID" → ID, and the youtu.be/ID short form → its last path segment.
  const videoId = new URL(url).searchParams.get("v") ?? url.split("/").pop()!;
  const filePrefix = path.join(YT_DIR, videoId);
  try {
    // The info JSON is the marker that this video was already pulled: re-crawls skip the network.
    if (!fs.existsSync(`${filePrefix}.info.json`)) {
      await exec(
        "yt-dlp",
        [
          "--skip-download", // metadata and subtitles only; we never want the media
          "--write-info-json",
          "--write-auto-subs", // ASR captions: no human captions exist for these videos
          "--sub-langs",
          "en-orig,en", // prefer the original English track over a machine translation into English
          "--sub-format",
          "vtt",
          "--no-warnings",
          "-o",
          `${filePrefix}`,
          url,
        ],
        { timeout: VIDEO_FETCH_TIMEOUT_MS },
      );
    }
    const info = JSON.parse(fs.readFileSync(`${filePrefix}.info.json`, "utf8"));
    const subtitleFile = [`${filePrefix}.en-orig.vtt`, `${filePrefix}.en.vtt`].find((file) => fs.existsSync(file));
    const text = subtitleFile ? vttToText(fs.readFileSync(subtitleFile, "utf8")) : "";
    return {
      url,
      id: videoId,
      title: info.title ?? videoId,
      channel: info.channel ?? info.uploader ?? "",
      uploadDate: isoUploadDate(info.upload_date),
      durationSec: info.duration ?? 0,
      text,
    };
  } catch (error: any) {
    console.warn(`  yt-dlp failed for ${videoId}:`, errorExcerpt(error));
    return null;
  }
}

/**
 * WebVTT → plain prose.
 *
 * Auto-generated captions are written as a rolling two-line window, so every line is emitted
 * twice: once as the incoming line and once as the scrolled-up line. Without the adjacent-line
 * dedupe below, every sentence in the corpus would appear twice, which doubles the token cost of
 * a chunk and makes a repeated phrase look like emphasis to the reader and to the model.
 */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const rawLine of vtt.split("\n")) {
    // Inline caption markup: "<c>word</c>" karaoke spans and "<00:00:01.500>" word timings.
    const line = rawLine.replace(/<[^>]+>/g, "").trim();
    // Skip everything that is not spoken text: the "WEBVTT" magic line, the "Kind: captions" and
    // "Language: en" headers, a bare cue number "12", any timing line containing "-->", and
    // "NOTE …" annotations.
    if (!line || /^WEBVTT|^Kind:|^Language:|^\d+$|-->|^NOTE/.test(line)) continue;
    if (lines[lines.length - 1] === line) continue; // the rolling-window duplicate
    lines.push(line);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** Exposes the configured channel cap. Nothing else in the repo imports it today (checked by grep). */
export function youtubeSeedVideos() {
  const config = getConfig().crawl;
  return { limit: config.youtube_channel_videos };
}

/** yt-dlp reports the upload day as "20240131"; the rest of the corpus stores ISO "2024-01-31". */
function isoUploadDate(uploadDate: string | undefined): string | null {
  if (!uploadDate) return null;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

/** yt-dlp errors are long; keep the useful head of the message out of the crawl log's way. */
function errorExcerpt(error: any): string {
  return String(error?.message ?? error).slice(0, ERROR_EXCERPT_CHARS);
}
