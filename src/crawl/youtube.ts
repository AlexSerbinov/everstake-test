// Video → text via yt-dlp auto-generated subtitles (no human captions exist for these videos).
// Zero transcription cost; quality is ASR-grade, so these documents are tier 3 and never
// the sole evidence for a fact.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, getConfig } from "../config.js";

const exec = promisify(execFile);
const YT_DIR = path.join(DATA_DIR, "youtube");

export interface VideoDoc { url: string; id: string; title: string; channel: string; uploadDate: string | null; durationSec: number; text: string }

export async function listChannelVideos(channelUrl: string, limit: number): Promise<string[]> {
  try {
    const { stdout } = await exec("yt-dlp", ["--flat-playlist", "--playlist-end", String(limit), "--print", "%(id)s", channelUrl], { timeout: 120_000 });
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean).map((id) => `https://www.youtube.com/watch?v=${id}`);
  } catch (e: any) {
    console.warn("  yt-dlp channel listing failed:", String(e?.message ?? e).slice(0, 200));
    return [];
  }
}

export async function fetchVideo(url: string): Promise<VideoDoc | null> {
  fs.mkdirSync(YT_DIR, { recursive: true });
  const id = new URL(url).searchParams.get("v") ?? url.split("/").pop()!;
  const base = path.join(YT_DIR, id);
  try {
    if (!fs.existsSync(`${base}.info.json`)) {
      await exec("yt-dlp", [
        "--skip-download", "--write-info-json", "--write-auto-subs", "--sub-langs", "en-orig,en", "--sub-format", "vtt",
        "--no-warnings", "-o", `${base}`, url,
      ], { timeout: 180_000 });
    }
    const info = JSON.parse(fs.readFileSync(`${base}.info.json`, "utf8"));
    const vtt = [`${base}.en-orig.vtt`, `${base}.en.vtt`].find((f) => fs.existsSync(f));
    const text = vtt ? vttToText(fs.readFileSync(vtt, "utf8")) : "";
    const ud: string | undefined = info.upload_date;
    return {
      url, id, title: info.title ?? id, channel: info.channel ?? info.uploader ?? "",
      uploadDate: ud ? `${ud.slice(0, 4)}-${ud.slice(4, 6)}-${ud.slice(6, 8)}` : null,
      durationSec: info.duration ?? 0, text,
    };
  } catch (e: any) {
    console.warn(`  yt-dlp failed for ${id}:`, String(e?.message ?? e).slice(0, 200));
    return null;
  }
}

/** WebVTT → plain prose. Auto captions repeat each line twice (rolling window) — dedupe adjacent lines. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split("\n")) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || /^WEBVTT|^Kind:|^Language:|^\d+$|-->|^NOTE/.test(line)) continue;
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

export function youtubeSeedVideos() {
  const cfg = getConfig().crawl;
  return { limit: cfg.youtube_channel_videos };
}
