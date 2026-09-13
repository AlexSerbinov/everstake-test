import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { openDatabase } from "../src/storage/database.js";
import { activateReviewedYouTube } from "../src/services/youtube/activate-reviewed.js";
import { createEmbeddingClient } from "../src/providers/model-client.js";
import { beginRun, finishRun } from "../src/services/measurements/runs.js";
import type { DocumentSnapshot } from "../src/contracts.js";

if (existsSync(".env")) loadEnvFile(".env");
const documents = JSON.parse(
  readFileSync("artifacts/youtube/reviewed/documents.json", "utf8"),
) as DocumentSnapshot[];
if (
  !documents.length ||
  documents.some(
    (d) =>
      d.kind !== "youtube" ||
      d.metadata.reviewStatus !== "reviewed" ||
      d.metadata.sourceId !== "youtube-inventory",
  )
)
  throw new Error("Only reviewed YouTube testimony can be activated");
const db = openDatabase();
const runId = beginRun(db, "youtube_index", { documents: documents.length });
try {
  const { index: result, embeddings } = await activateReviewedYouTube(
    db,
    documents,
    createEmbeddingClient(db),
    runId,
  );
  finishRun(db, runId, "completed");
  console.log(JSON.stringify({ result, embeddings }));
} catch (e) {
  finishRun(db, runId, "failed");
  throw e;
} finally {
  db.close();
}
