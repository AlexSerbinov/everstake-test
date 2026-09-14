import type { Database } from "../../storage/database.js";
import { buildReceipt, costOverview } from "./receipt.js";

interface RunRow {
  id: string;
  kind: string;
  started_at: string;
  status: string;
  metadata: string;
}
interface CallRow {
  run_id: string;
  provider: string;
  model: string;
  stage: string;
  started_at: string;
  cost_usd: number | null;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
}
function metadata(value: string): Record<string, unknown> {
  try {
    const result = JSON.parse(value);
    return result && typeof result === "object" ? result : {};
  } catch {
    return {};
  }
}
function summarize(rows: CallRow[]) {
  return {
    calls: rows.length,
    knownCostUsd: rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    inputTokens: rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    unknownCalls: rows.filter((row) => row.cost_usd === null).length,
    pendingCalls: rows.filter((row) => row.status === "pending").length,
    unpricedFinalCalls: rows.filter(
      (row) => row.cost_usd === null && row.status !== "pending",
    ).length,
    errorCalls: rows.filter((row) =>
      ["error", "timed_out", "cancelled"].includes(row.status),
    ).length,
  };
}
export function costDashboard(db: Database) {
  const overview = costOverview(db);
  const runs = db
    .prepare("SELECT * FROM runs ORDER BY started_at DESC, rowid DESC")
    .all() as unknown as RunRow[];
  const calls = db
    .prepare("SELECT * FROM api_calls ORDER BY started_at")
    .all() as unknown as CallRow[];
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const parents = new Map(
    runs.map((run) => [run.id, metadata(run.metadata).parentRunId]),
  );
  const roots = new Map(
    runs.map((run) => [run.id, findRoot(run.id, parents, runsById)]),
  );
  const rootRuns = runs.filter((run) => roots.get(run.id) === run.id);
  const rootCalls = groupCalls(
    calls,
    (call) => roots.get(call.run_id) ?? call.run_id,
  );
  // A verification call belongs to its nearest question, even within an evaluation.
  const queryCalls = groupCalls(calls, (call) =>
    findQuestion(call.run_id, parents, runsById),
  );
  const queryRuns = runs.filter(isQuestion);
  // Website and video refreshes share this kind. Nested refreshes count only once.
  const updateRuns = rootRuns.filter((run) => run.kind === "refresh");
  const byPurpose = summarizeGroups(
    calls,
    (call) =>
      runsById.get(roots.get(call.run_id) ?? call.run_id)?.kind ?? "unassigned",
  ).sort((a, b) => b.knownCostUsd - a.knownCostUsd);
  const byStage = summarizeGroups(calls, (call) => call.stage).sort(
    (a, b) => b.knownCostUsd - a.knownCostUsd,
  );
  const daily = summarizeGroups(calls, (call) =>
    call.started_at.slice(0, 10),
  ).sort((a, b) => a.label.localeCompare(b.label));
  const index = summarize(
    calls.filter((call) => {
      const kind = runsById.get(call.run_id)?.kind;
      const rootKind = runsById.get(roots.get(call.run_id) ?? "")?.kind;
      return (
        kind === "index" ||
        rootKind === "index" ||
        ["index", "index-embedding", "index_embedding"].includes(call.stage)
      );
    }),
  );
  const documents = Number(
    (
      db
        .prepare("SELECT count(*) AS n FROM documents WHERE active=1")
        .get() as { n: number }
    ).n,
  );
  return {
    ...overview,
    ...summarize(calls),
    byPurpose,
    byProvider: summarizeProviders(calls),
    update: {
      ...summarizeCompletedRuns(updateRuns, rootCalls),
      knownCostUsd: summarize(
        updateRuns.flatMap((run) => rootCalls.get(run.id) ?? []),
      ).knownCostUsd,
    },
    byStage,
    daily,
    query: summarizeCompletedRuns(queryRuns, queryCalls),
    index,
    forecast: {
      factor: 50,
      documents,
      projectedDocuments: documents * 50,
      knownIndexCostUsd: index.knownCostUsd,
      projectedIndexCostUsd: index.knownCostUsd * 50,
      inputTokens: index.inputTokens,
      projectedInputTokens: index.inputTokens * 50,
      unknownCalls: index.unknownCalls,
    },
    totalRuns: runs.length,
    totalRootRuns: rootRuns.length,
    runs: rootRuns.slice(0, 100).map((run) => ({
      id: run.id,
      kind: run.kind,
      startedAt: run.started_at,
      status: run.status,
      // The public ledger reports spending, not other visitors' prompts.
      question: null,
      childRuns: runs
        .filter(
          (child) => child.id !== run.id && roots.get(child.id) === run.id,
        )
        .map((child) => ({
          id: child.id,
          kind: child.kind,
          question: null,
        })),
      receipt: buildReceipt(db, run.id),
    })),
  };
}
// Keep call order inside each group: even the order of decimal additions stays unchanged.
function groupCalls(
  calls: CallRow[],
  key: (call: CallRow) => string | undefined,
) {
  const groups = new Map<string, CallRow[]>();
  for (const call of calls) {
    const label = key(call);
    if (label === undefined) continue;
    const rows = groups.get(label) ?? [];
    rows.push(call);
    groups.set(label, rows);
  }
  return groups;
}

function summarizeGroups(calls: CallRow[], key: (call: CallRow) => string) {
  return [...groupCalls(calls, key)].map(([label, rows]) => ({
    label,
    ...summarize(rows),
  }));
}

function isQuestion(run: RunRow) {
  return run.kind === "query" || run.kind === "question";
}

function findRoot(
  id: string,
  parents: Map<string, unknown>,
  runs: Map<string, RunRow>,
): string {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const parent = parents.get(id);
    if (typeof parent !== "string" || !runs.has(parent)) return id;
    id = parent;
  }
  // Old imports may contain parent cycles. Preserve their deterministic fallback.
  return [...seen].sort()[0];
}

function findQuestion(
  id: string,
  parents: Map<string, unknown>,
  runs: Map<string, RunRow>,
): string | undefined {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const run = runs.get(id);
    if (run && isQuestion(run)) return id;
    const parent = parents.get(id);
    if (typeof parent !== "string") return undefined;
    id = parent;
  }
  return undefined;
}

function summarizeCompletedRuns(
  runs: RunRow[],
  callsByRun: Map<string, CallRow[]>,
) {
  const costs = runs
    .map((run) => ({ run, receipt: summarize(callsByRun.get(run.id) ?? []) }))
    // A failed run or missing price is not a trustworthy cost-per-run sample.
    .filter(
      ({ run, receipt }) =>
        run.status === "completed" && receipt.unknownCalls === 0,
    )
    .map(({ receipt }) => receipt.knownCostUsd);
  return {
    runs: runs.length,
    measuredRuns: costs.length,
    excludedRuns: runs.length - costs.length,
    meanUsd: costs.length
      ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length
      : null,
    minUsd: costs.length ? Math.min(...costs) : null,
    maxUsd: costs.length ? Math.max(...costs) : null,
  };
}

function summarizeProviders(calls: CallRow[]) {
  const providerIds = [
    "soniox",
    "gemini",
    "openai",
    ...new Set(
      calls
        .map((call) => call.provider)
        .filter(
          (provider) => !["soniox", "gemini", "openai"].includes(provider),
        ),
    ),
  ];
  return providerIds.map((provider) => {
    const rows = calls.filter((call) => call.provider === provider);
    return {
      provider,
      ...summarize(rows),
      models: [...new Set(rows.map((row) => row.model))]
        .map((model) => ({
          model,
          ...summarize(rows.filter((row) => row.model === model)),
        }))
        .sort((a, b) => b.knownCostUsd - a.knownCostUsd),
    };
  });
}

export type CostDashboard = ReturnType<typeof costDashboard>;
