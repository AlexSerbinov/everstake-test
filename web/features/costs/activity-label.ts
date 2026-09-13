const labels: Record<string, string> = {
  query: "Question",
  question: "Question",
  baseline: "Comparison answer",
  index: "Search preparation",
  crawl: "Source collection",
  build: "Source collection",
  refresh: "Source update",
  evaluation: "Evaluation",
  "mcp-evaluation": "MCP comparison",
  youtube_transcription: "Video transcription",
};
export function activityLabel(kind: string): string {
  return labels[kind] ?? kind.replaceAll("_", " ");
}
export function activityTitle(
  kind: string,
  question: string | null,
  id: string,
): string {
  return question?.trim() || `${activityLabel(kind)} · ${id.slice(0, 8)}`;
}
