import { formatTimestamp, type Turn } from "./turns.js";

/** Readable acquisition artifact; speaker labels are not verified identities or indexed facts. */
export function renderTranscript(
  video: { title: string; url: string; publishedAt: string | null },
  turns: Turn[],
): string {
  const heading = video.title.replace(/[\r\n]/g, " ");
  let markdown = `# ${heading}\n\nSource: ${video.url}\n\nUploaded: ${video.publishedAt ?? "unknown"}\n\nStatus: transcribed, not reviewed. Speaker labels come from Soniox and do not identify people. Questions, corrections and factual claims remain unclassified. This transcript is not an accepted knowledge-base source yet.\n\n`;
  for (const turn of turns) {
    const time =
      turn.startMs === null ? "unknown time" : formatTimestamp(turn.startMs);
    const url =
      turn.startMs === null
        ? video.url
        : `${video.url}&t=${Math.floor(turn.startMs / 1000)}`;
    markdown += `## [${time}](${url}) — Speaker ${turn.speaker ?? "unknown"}\n\n${turn.text}\n\n`;
  }
  return markdown;
}
