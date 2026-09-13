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
  withRun,
} from "./services/measurements/index.js";
import { answerQuestion } from "./services/answer/answer-question.js";
import { hybridSearch, embedCorpus } from "./services/search/hybrid-search.js";
import { readActiveDocuments } from "./workflows/build-corpus.js";
import { buildIndex } from "./services/indexer/build-index.js";
import { refreshCorpus } from "./workflows/refresh-corpus.js";
import { readSources } from "./config.js";
import { getSetting, type Database } from "./storage/database.js";
import type { Emit } from "./contracts.js";
export function createApplication(db: Database) {
  const model = createModelClient(db);
  const embeddings = createEmbeddingClient(db);
  const ask = async (
    question: string,
    emit: Emit = () => {},
    mode: "agent" | "baseline" = "agent",
  ) => {
    const runId = beginRun(db, mode === "agent" ? "query" : "baseline", {
      ...runtimeManifest(),
      question,
      corpusVersion: getSetting(db, "corpus_version"),
    });
    return answerQuestion(
      {
        db,
        model,
        search: (query, limit) =>
          hybridSearch(db, embeddings, runId, query, limit),
        receipt: (id) => buildReceipt(db, id),
        finish: (id, status) =>
          finishRun(db, id, status === "error" ? "failed" : "completed"),
      },
      question,
      runId,
      emit,
      mode,
    );
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
    options: { due?: boolean; resumeJobId?: string } = {},
  ) => {
    let sources = readSources();
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
    }
  };
  return { db, ask, costs, refresh, model, embeddings };
}
