import { sanitizeDocument } from "../evidence/sanitize-document.js";
import type { Database } from "../../storage/database.js";
import type { DocumentSnapshot, EvidencePassage } from "../../contracts.js";

/** FTS retrieves candidates; authority and dates remain visible for evidence comparison. */
export function searchCorpus(
  db: Database,
  query: string,
  limit = 12,
): EvidencePassage[] {
  const words = [...new Set(query.match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(
    0,
    24,
  );
  if (!words.length) return [];
  const expression = words
    .map((w) => `"${w.replaceAll('"', "")}"`)
    .join(" OR ");
  const rows = db
    .prepare(
      `SELECT c.id,c.document_id,c.text,bm25(chunks_fts) AS rank,d.snapshot
 FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.id JOIN documents d ON d.id=c.document_id
 WHERE chunks_fts MATCH ? AND d.active=1 ORDER BY rank LIMIT 100`,
    )
    .all(expression) as unknown as {
    id: string;
    document_id: string;
    text: string;
    rank: number;
    snapshot: string;
  }[];
  const groups = new Map<string, number>();
  const results: EvidencePassage[] = [];
  for (const row of rows) {
    const document = JSON.parse(row.snapshot) as DocumentSnapshot;
    const group = document.duplicateOf ?? document.id;
    if ((groups.get(group) ?? 0) >= 2) continue;
    groups.set(group, (groups.get(group) ?? 0) + 1);
    results.push(
      passage(
        document,
        row.id,
        row.text,
        -row.rank,
        "Lexical match; at most two passages per duplicate group",
      ),
    );
    if (results.length >= Math.min(limit, 30)) break;
  }
  return results;
}
export function passage(
  d: DocumentSnapshot,
  id: string,
  text: string,
  score = 0,
  reason = "Requested document section",
): EvidencePassage {
  const metadata = visibleMetadata(d.metadata);
  let url = d.url;
  if (d.kind === "youtube") {
    const stamp = text.match(/\[(?:(\d+):)?(\d{1,2}):(\d{2})\]/);
    if (stamp) {
      const seconds =
        Number(stamp[1] ?? 0) * 3600 + Number(stamp[2]) * 60 + Number(stamp[3]);
      metadata.startMs = seconds * 1000;
      const deepLink = new URL(url);
      deepLink.searchParams.set("t", String(seconds));
      url = deepLink.toString();
    }
  }
  return {
    id,
    documentId: d.id,
    url,
    title: safeTitle(d),
    text,
    authority: d.authority,
    publisher: d.publisher,
    publishedAt: d.publishedAt,
    updatedAt: d.updatedAt,
    fetchedAt: d.fetchedAt,
    duplicateGroup: d.duplicateOf ?? d.id,
    score,
    reason,
    metadata,
  };
}
export function readDocument(
  db: Database,
  documentId: string,
  offset = 0,
  query?: string,
): EvidencePassage[] {
  const row = db
    .prepare("SELECT snapshot FROM documents WHERE id=? AND active=1")
    .get(documentId) as { snapshot: string } | undefined;
  if (!row) return [];
  const d = JSON.parse(row.snapshot) as DocumentSnapshot;
  const chunks = db
    .prepare(
      "SELECT id,text,ordinal FROM chunks WHERE document_id=? ORDER BY ordinal",
    )
    .all(documentId) as {
    id: string;
    text: string;
    ordinal: number;
  }[];
  const words = [
    ...new Set(query?.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []),
  ];
  // Search the complete indexed document, not only its first window or the globally
  // diversified search results. Nothing is fetched or taken from unsanitized snapshots.
  const ranked = words.length
    ? chunks
        .map((c) => ({
          c,
          score: words.reduce(
            (n, word) => n + (c.text.toLowerCase().includes(word) ? 1 : 0),
            0,
          ),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || a.c.ordinal - b.c.ordinal)
        .map(({ c }) => c)
    : chunks;
  const start = Math.max(0, Math.min(offset, 500));
  return ranked.slice(start, start + 4).map((c) => ({
    ...passage(d, c.id, c.text),
    metadata: {
      ...visibleMetadata(d.metadata),
      chunkOrdinal: c.ordinal,
      documentChunks: chunks.length,
      matchingChunks: ranked.length,
      nextOffset: start + 4 < ranked.length ? start + 4 : null,
      readQuery: query ?? null,
    },
  }));
}

function sanitizeField(value: string): string {
  return sanitizeDocument(value).text.replace(/\s+/g, " ").trim();
}

/** Preserve the deployed title and metadata sanitization when reading more chunks. */
export function safeTitle(d: Pick<DocumentSnapshot, "title" | "url">): string {
  const title = sanitizeField(d.title);
  if (title) return title;
  try {
    return new URL(d.url).hostname;
  } catch {
    return "Untitled source";
  }
}

/** Only presentation provenance reaches the model, never raw sanitation audit text. */
export function visibleMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const keys = [
    "sourceId",
    "videoId",
    "startMs",
    "endMs",
    "speaker",
    "speakerName",
    "roleAtRecording",
    "speakerStatus",
    "reviewStatus",
    "recordedAt",
    "refreshStatus",
    "freshnessNote",
    "authorityScope",
  ];
  return Object.fromEntries(
    keys
      .filter((k) => metadata[k] !== undefined)
      .map((k) => [
        k,
        typeof metadata[k] === "string"
          ? sanitizeField(metadata[k] as string)
          : metadata[k],
      ]),
  );
}
