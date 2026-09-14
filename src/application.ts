import { costDashboard } from "./services/measurements/cost-dashboard.js";
import { createUpdateController } from "./services/updates/controller.js";
import type { UpdateSettings } from "./services/updates/settings.js";
import { refreshVideos } from "./services/updates/refresh-videos.js";
import { stagedRefresh, dueSources } from "./workflows/staged-refresh.js";
import { runtimeManifest } from "./runtime-manifest.js";
import {
  createModelClient,
  createEmbeddingClient,
} from "./providers/model-client.js";
import {
  beginRun,
  finishRun,
  buildReceipt,
} from "./services/measurements/index.js";
import { answerQuestion } from "./services/answer/answer-question.js";
import { hybridSearch } from "./services/search/hybrid-search.js";
import { readActiveDocuments } from "./workflows/build-corpus.js";
import { buildIndex } from "./services/indexer/build-index.js";
import { readSources } from "./config.js";
import { getSetting, type Database } from "./storage/database.js";
import type { Emit } from "./contracts.js";
/** Connect the same answer, search, accounting, and update services for both HTTP and CLI. */
export function createApplication(db: Database) {
  // The in-process guard keeps a question on one corpus. Refresh also uses a database
  // lease so a separate CLI process cannot publish over another update.
  let activeQuestions = 0;
  let updating = false;
  const model = createModelClient(db);
  const embeddings = createEmbeddingClient(db);
  const ask = async (
    question: string,
    emit: Emit = () => {},
    mode: "agent" | "baseline" = "agent",
    signal?: AbortSignal,
  ) => {
    if (updating)
      throw new Error("Corpus update in progress; please try again shortly");
    activeQuestions++;
    try {
      const runId = beginRun(db, mode === "agent" ? "query" : "baseline", {
        ...runtimeManifest(),
        question,
        corpusVersion: getSetting(db, "corpus_version"),
      });
      return await answerQuestion(
        {
          db,
          model,
          search: (query, limit) =>
            hybridSearch(db, embeddings, runId, query, limit),
          receipt: (id) => buildReceipt(db, id),
          finish: (id, status) =>
            finishRun(
              db,
              id,
              status === "cancelled"
                ? "cancelled"
                : status === "error"
                  ? "failed"
                  : "completed",
            ),
          signal,
        },
        question,
        runId,
        emit,
        mode,
      );
    } finally {
      activeQuestions--;
    }
  };
  const costs = () => costDashboard(db);
  const refresh = async (
    sourceId?: string,
    options: {
      due?: boolean;
      resumeJobId?: string;
      onPhase?: (phase: string) => void;
    } = {},
  ) => {
    if (activeQuestions || updating)
      throw new Error("Another operation is active");
    let sources = readSources().filter((s) => s.kind !== "youtube");
    if (sourceId) {
      sources = sources.filter((s) => s.id === sourceId);
      if (!sources.length) throw new Error("Unknown source ID");
    }
    if (options.due) sources = dueSources(db, sources);
    if (!sources.length)
      return {
        status: "nothing_due",
        corpusVersion: getSetting(db, "corpus_version"),
      };
    const runId = beginRun(db, "refresh", {
      ...runtimeManifest(),
      sourceId,
      ...options,
    });
    updating = true;
    try {
      const result = await stagedRefresh(
        db,
        sources,
        embeddings,
        runId,
        options,
      );
      finishRun(db, runId, "completed");
      return { ...result, receipt: buildReceipt(db, runId) };
    } catch (error) {
      finishRun(db, runId, "failed");
      throw error;
    } finally {
      updating = false;
    }
  };
  /** The queue uses one named operation for both manual and scheduled source updates. */
  async function executeSourceUpdate(
    sourceId: string,
    settings: UpdateSettings,
    progress: (phase: string) => void,
  ) {
    if (sourceId !== "youtube") {
      const result = await refresh(sourceId, { onPhase: progress });
      if (!("job" in result)) return result;
      return {
        corpusVersion: result.corpusVersion,
        jobId: result.job.id,
        counts: result.job.counts,
        receipt: result.receipt,
      };
    }
    if (activeQuestions || updating)
      throw new Error("Another operation is active");
    updating = true;
    const runId = beginRun(db, "refresh", { ...runtimeManifest(), sourceId });
    try {
      const videos = await refreshVideos(
        db,
        model,
        runId,
        settings.youtubeMaximumVideos,
        progress,
      );
      const active = readActiveDocuments(db);
      const activeDocumentIds = new Set(active.map((document) => document.id));
      const newVideoDocuments = videos.documents.filter(
        (document) => !activeDocumentIds.has(document.id),
      );
      // Video ingestion shares the website staging/activation boundary.
      // Reviewed transcripts become evidence only after their vectors are ready.
      if (newVideoDocuments.length) {
        await stagedRefresh(
          db,
          [
            {
              id: "youtube",
              url: "https://www.youtube.com",
              publisher: "YouTube",
              kind: "youtube",
              authority: 3,
              reason: "Incremental reviewed videos",
              enabled: true,
            },
          ],
          embeddings,
          runId,
          {
            onPhase: progress,
            collect: async (stage) => {
              const index = buildIndex(stage, [
                ...readActiveDocuments(stage),
                ...newVideoDocuments,
              ]);
              return {
                crawls: [],
                failures: [],
                retainedSourceIds: [],
                index,
              };
            },
          },
        );
      }
      finishRun(db, runId, "completed");
      const { documents, ...counts } = videos;
      return {
        counts: { ...counts, added: newVideoDocuments.length },
        corpusVersion: getSetting(db, "corpus_version"),
        receipt: buildReceipt(db, runId),
      };
    } catch (error) {
      finishRun(db, runId, "failed");
      throw error;
    } finally {
      updating = false;
    }
  }

  const updates = createUpdateController(db, executeSourceUpdate, {
    available: () => activeQuestions === 0 && !updating,
  });
  return { db, ask, costs, refresh, model, embeddings, updates };
}
