import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpeakerReview } from "./review-speakers.js";
import { formatTimestamp, type Turn } from "./turns.js";
import { isEvidenceEligible } from "./evidence-turns.js";

interface Video {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

export interface ReviewedTranscriptExport {
  markdownPath: string;
  jsonPath: string;
  basename: string;
  title: string;
  videoId: string;
  sourceUrl: string;
  reviewStatus: SpeakerReview["status"];
}

/** Presentation exports do not replace stable-ID caches or automatically activate corpus documents. */
export function exportReviewedTranscript(
  video: Video,
  turns: Turn[],
  review: SpeakerReview,
  outputDirectory: string,
): ReviewedTranscriptExport {
  if (!/^[a-zA-Z0-9_-]+$/.test(video.id))
    throw new Error("Invalid video ID for transcript export");
  const date =
    video.publishedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "date-unknown";
  const titleSlug =
    video.title
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .slice(0, 100)
      .replace(/^-+|-+$/g, "") || "interview";
  let slug = "";
  for (const character of titleSlug) {
    if (Buffer.byteLength(slug + character, "utf8") > 180) break;
    slug += character;
  }
  const basename = `${date}-${slug.replace(/-+$/g, "")}--${video.id}`;
  const speakers = new Map(
    review.speakers.map((speaker) => [speaker.label, speaker]),
  );
  const enrichedTurns = turns.map((turn, index) => {
    const speaker =
      turn.speaker === null ? undefined : speakers.get(turn.speaker);
    return {
      ...turn,
      turnIndex: index,
      speakerName: speaker?.name ?? null,
      roleAtRecording: speaker?.roleAtRecording ?? null,
      participantType: speaker?.participantType ?? "unknown",
      evidenceEligible: isEvidenceEligible(turn, index, review),
    };
  });
  let markdown = `# ${inline(video.title)}\n\nSource: ${video.url}\n\nUploaded: ${video.publishedAt ?? "unknown"}\n\nVideo ID: ${video.id}\n\nSpeaker review: ${review.status}\n\n`;
  markdown +=
    "Speaker names and roles are contextual model attributions at the time of recording, not independently verified current employment. Evidence eligibility is a filtering decision, not a guarantee of factual truth. All dialogue is preserved, including questions and rejected claims. This export does not activate a corpus source.\n\n";
  markdown +=
    "## Speakers\n\n| Original label | Name | Role at recording | Participant type | Attribution basis |\n| --- | --- | --- | --- | --- |\n";
  for (const speaker of review.speakers) {
    markdown += `| ${inline(speaker.label)} | ${inline(speaker.name ?? "unknown")} | ${inline(speaker.roleAtRecording ?? "unknown")} | ${speaker.participantType} | ${inline(speaker.reason)} |\n`;
  }
  if (
    turns.some((turn) => turn.speaker === null || !speakers.has(turn.speaker))
  )
    markdown +=
      "\nUnmapped or missing speaker labels remain unknown and are not evidence eligible.\n";
  markdown += "\n## Limitations\n\n";
  markdown += review.limitations.length
    ? review.limitations
        .map((limitation) => `- ${inline(limitation)}\n`)
        .join("")
    : "- No additional limitations reported by the model; speaker attribution still requires caution.\n";
  for (const interval of review.suspiciousIntervals)
    markdown += `- Uncertain speaker interval, turns ${interval.fromTurn}–${interval.toTurn}: ${inline(interval.reason)}\n`;
  markdown += "\n## Transcript\n\n";
  for (const turn of enrichedTurns) {
    const url = new URL(video.url);
    if (turn.startMs !== null)
      url.searchParams.set("t", String(Math.floor(turn.startMs / 1000)));
    markdown += `### [${formatTimestamp(turn.startMs)}](${url.href}) — ${inline(turn.speakerName ?? "Unknown person")} · ${inline(turn.roleAtRecording ?? "role unknown")} · ${turn.participantType}\n\n`;
    markdown += `Turn ${turn.turnIndex} · original label: ${inline(turn.speaker ?? "unknown")} · evidence eligible: ${turn.evidenceEligible ? "yes" : "no"}\n\n${turn.text}\n\n`;
  }
  mkdirSync(outputDirectory, { recursive: true });
  const markdownPath = join(outputDirectory, `${basename}.md`);
  const jsonPath = join(outputDirectory, `${basename}.json`);
  writeFileSync(markdownPath, markdown);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        videoId: video.id,
        title: video.title,
        sourceUrl: video.url,
        uploadedAt: video.publishedAt,
        reviewStatus: review.status,
        speakerReview: review,
        turns: enrichedTurns,
      },
      null,
      2,
    ) + "\n",
  );
  return {
    markdownPath,
    jsonPath,
    basename,
    title: video.title,
    videoId: video.id,
    sourceUrl: video.url,
    reviewStatus: review.status,
  };
}

export function exportReviewedTranscriptIndex(
  exports: ReviewedTranscriptExport[],
  outputDirectory: string,
): string {
  mkdirSync(outputDirectory, { recursive: true });
  const path = join(outputDirectory, "README.md");
  const rows = exports.map(
    (item) =>
      `| [${inline(item.title)}](${encodeURIComponent(item.basename)}.md) | ${item.reviewStatus} | [Video](${item.sourceUrl}) | [JSON](${encodeURIComponent(item.basename)}.json) |`,
  );
  writeFileSync(
    path,
    "# Reviewed YouTube transcripts\n\nFull dialogue with contextual speaker attribution, recording-time roles and source timestamps. Unknown identities remain explicit. These exports are not automatic corpus approvals.\n\n| Transcript | Review | Source | Structured data |\n| --- | --- | --- | --- |\n" +
      rows.join("\n") +
      "\n",
  );
  return path;
}

function inline(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}
