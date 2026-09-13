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
  const runMap = new Map(runs.map((run) => [run.id, run]));
  const meta = new Map(runs.map((run) => [run.id, metadata(run.metadata)]));
  // Every ledger row belongs to exactly one root, even if legacy metadata contains a cycle.
  function rootId(id: string): string {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const parent = meta.get(id)?.parentRunId;
      if (typeof parent !== "string" || !runMap.has(parent)) return id;
      id = parent;
    }
    return [...seen].sort()[0];
  }
  const roots = new Map(runs.map((run) => [run.id, rootId(run.id)]));
  function group(key: (call: CallRow) => string) {
    const groups = new Map<string, CallRow[]>();
    for (const call of calls) {
      const label = key(call);
      const list = groups.get(label) ?? [];
      list.push(call);
      groups.set(label, list);
    }
    return [...groups].map(([label, rows]) => ({ label, ...summarize(rows) }));
  }
  const byPurpose = group(
    (call) =>
      runMap.get(roots.get(call.run_id) ?? call.run_id)?.kind ?? "unassigned",
  ).sort((a, b) => b.knownCostUsd - a.knownCostUsd);
  const byStage = group((call) => call.stage).sort(
    (a, b) => b.knownCostUsd - a.knownCostUsd,
  );
  const daily = group((call) => call.started_at.slice(0, 10)).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
  const queryRuns = runs.filter((run) =>
    ["query", "question"].includes(run.kind),
  );
  const queryCalls = new Map<string, CallRow[]>();
  for (const call of calls) {
    let id = call.run_id;
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      if (["query", "question"].includes(runMap.get(id)?.kind ?? "")) {
        const list = queryCalls.get(id) ?? [];
        list.push(call);
        queryCalls.set(id, list);
        break;
      }
      const parent = meta.get(id)?.parentRunId;
      if (typeof parent !== "string") break;
      id = parent;
    }
  }
  const queries = queryRuns.map((run) => ({
    run,
    receipt: summarize(queryCalls.get(run.id) ?? []),
  }));
  const complete = queries.filter(
    ({ run, receipt }) =>
      run.status === "completed" && receipt.unknownCalls === 0,
  );
  const queryCosts = complete.map(({ receipt }) => receipt.knownCostUsd);
  const rootRuns = runs.filter((run) => roots.get(run.id) === run.id);
  const rootCalls = new Map<string, CallRow[]>();
  for (const call of calls) {
    const root = roots.get(call.run_id) ?? call.run_id;
    const rows = rootCalls.get(root) ?? [];
    rows.push(call);
    rootCalls.set(root, rows);
  }
  // Both website and incremental YouTube updates are recorded as refresh roots.
  // A root can represent one source or a CLI multi-source refresh, not a UI batch.
  const updateRuns = rootRuns.filter((run) => run.kind === "refresh");
  const measuredUpdates = updateRuns
    .map((run) => ({ run, receipt: summarize(rootCalls.get(run.id) ?? []) }))
    .filter(
      ({ run, receipt }) =>
        run.status === "completed" && receipt.unknownCalls === 0,
    );
  const updateCosts = measuredUpdates.map(
    ({ receipt }) => receipt.knownCostUsd,
  );
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
  const byProvider = providerIds.map((provider) => {
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
  const index = summarize(
    calls.filter((call) => {
      const kind = runMap.get(call.run_id)?.kind;
      const rootKind = runMap.get(roots.get(call.run_id) ?? "")?.kind;
      return (
        kind === "index" ||
        rootKind === "index" ||
        ["index", "index-embedding", "index_embedding"].includes(call.stage)
      );
    }),
  );
  return {
    ...overview,
    ...summarize(calls),
    byPurpose,
    byProvider,
    update: {
      runs: updateRuns.length,
      measuredRuns: measuredUpdates.length,
      excludedRuns: updateRuns.length - measuredUpdates.length,
      meanUsd: updateCosts.length
        ? updateCosts.reduce((sum, value) => sum + value, 0) /
          updateCosts.length
        : null,
      minUsd: updateCosts.length ? Math.min(...updateCosts) : null,
      maxUsd: updateCosts.length ? Math.max(...updateCosts) : null,
      knownCostUsd: summarize(
        updateRuns.flatMap((run) => rootCalls.get(run.id) ?? []),
      ).knownCostUsd,
    },
    byStage,
    daily,
    query: {
      runs: queries.length,
      measuredRuns: complete.length,
      excludedRuns: queries.length - complete.length,
      meanUsd: queryCosts.length
        ? queryCosts.reduce((a, b) => a + b, 0) / queryCosts.length
        : null,
      minUsd: queryCosts.length ? Math.min(...queryCosts) : null,
      maxUsd: queryCosts.length ? Math.max(...queryCosts) : null,
    },
    index,
    forecast: {
      factor: 50,
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
export type CostDashboard = ReturnType<typeof costDashboard>;
