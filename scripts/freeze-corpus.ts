import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { openDatabase } from "../src/storage/database.js";
import { readActiveDocuments } from "../src/workflows/build-corpus.js";
import { sanitizeDocument } from "../src/services/evidence/sanitize-document.js";
import { plausibleDate } from "../src/services/crawler/extract.js";
import { buildIndex } from "../src/services/indexer/build-index.js";
import { runtimeManifest } from "../src/runtime-manifest.js";
const db = openDatabase();
let changed = 0;
try {
  const videos = JSON.parse(
    readFileSync("artifacts/youtube/reviewed/documents.json", "utf8"),
  ) as import("../src/contracts.js").DocumentSnapshot[];
  const videoUrls = new Set(videos.map((d) => d.canonicalUrl));
  const documents = [
    ...readActiveDocuments(db).filter((d) => !videoUrls.has(d.canonicalUrl)),
    ...videos,
  ].map((document) => {
    const sanitized = sanitizeDocument(document.text);
    const historyRules = db
      .prepare("SELECT snapshot FROM documents WHERE url=? AND active=0")
      .all(document.url)
      .flatMap((row) =>
        sanitizeDocument(JSON.parse(String(row.snapshot)).text).removed.map(
          (r) => r.rule,
        ),
      );
    const text = sanitized.text;
    const contentHash = createHash("sha256").update(text).digest("hex");
    const id = createHash("sha256")
      .update(`${document.canonicalUrl}\n${contentHash}`)
      .digest("hex")
      .slice(0, 32);
    if (text !== document.text) changed++;
    return {
      ...document,
      id,
      contentHash,
      text,
      revision: contentHash.slice(0, 12),
      publishedAt: plausibleDate(document.publishedAt, document.fetchedAt),
      updatedAt: plausibleDate(document.updatedAt, document.fetchedAt),
      metadata: {
        ...document.metadata,
        removedInstructionCount:
          Number(document.metadata.removedInstructionCount ?? 0) +
          sanitized.removed.length,
        removedInstructionRules: [
          ...new Set([
            ...((document.metadata.removedInstructionRules as string[]) ?? []),
            ...sanitized.removed.map((r) => r.rule),
            ...historyRules,
          ]),
        ],
        sanitationVersion: "v2",
      },
    };
  });
  const report = buildIndex(db, documents);
  const manifest = {
    ...runtimeManifest(),
    ...report,
    sanitationChangedDocuments: changed,
    bySource: Object.fromEntries(
      [...new Set(documents.map((d) => String(d.metadata.sourceId)))].map(
        (id) => [
          id,
          documents.filter((d) => d.metadata.sourceId === id).length,
        ],
      ),
    ),
    documents: documents.map(
      ({
        id,
        url,
        title,
        contentHash,
        publishedAt,
        updatedAt,
        fetchedAt,
        kind,
        metadata,
      }) => ({
        id,
        url,
        title,
        contentHash,
        publishedAt,
        updatedAt,
        fetchedAt,
        kind,
        sourceId: metadata.sourceId,
      }),
    ),
  };
  mkdirSync("artifacts/corpus", { recursive: true });
  writeFileSync(
    "artifacts/corpus/frozen-manifest.json",
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    JSON.stringify({ ...report, sanitationChangedDocuments: changed }),
  );
} finally {
  db.close();
}
