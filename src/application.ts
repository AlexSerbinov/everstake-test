import { createUpdateController } from "./services/updates/controller.js";
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
  costOverview,
} from "./services/measurements/index.js";
import { answerQuestion } from "./services/answer/answer-question.js";
import { hybridSearch } from "./services/search/hybrid-search.js";
import { readActiveDocuments } from "./workflows/build-corpus.js";
import { buildIndex } from "./services/indexer/build-index.js";
import { readSources } from "./config.js";
import { getSetting, type Database } from "./storage/database.js";
import type { Emit } from "./contracts.js";
export function createApplication(db: Database) {
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
  const costs = () => ({
    ...costOverview(db),
    runs: db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 100")
      .all()
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        startedAt: r.started_at,
        status: r.status,
        question: null,
        receipt: buildReceipt(db, String(r.id)),
      })),
  });
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
  const updates = createUpdateController(
    db,
    async (sourceId, settings, progress) => {
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
        const ids = new Set(active.map((d) => d.id));
        const additions = videos.documents.filter((d) => !ids.has(d.id));
        if (additions.length) {
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
                  ...additions,
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
          counts: { ...counts, added: additions.length },
          corpusVersion: getSetting(db, "corpus_version"),
          receipt: buildReceipt(db, runId),
        };
      } catch (error) {
        finishRun(db, runId, "failed");
        throw error;
      } finally {
        updating = false;
      }
    },
    { available: () => activeQuestions === 0 && !updating },
  );
  return { db, ask, costs, refresh, model, embeddings, updates };
}
