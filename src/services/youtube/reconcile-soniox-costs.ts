import type { Database } from "../../storage/database.js";

interface Attempt {
  id: string;
  model: string;
  started_at: string;
  metadata: string;
}

/** Match our recorded operation IDs only; unrelated project usage is never imported. */
export async function reconcileSonioxCosts(
  db: Database,
  options: { apiKey?: string; fetch?: typeof fetch; now?: Date } = {},
) {
  const attempts = db
    .prepare(
      "SELECT id,model,started_at,metadata FROM api_calls WHERE provider='soniox' AND status='completed' AND cost_usd IS NULL ORDER BY started_at",
    )
    .all() as unknown as Attempt[];
  if (!attempts.length) return { reconciled: 0, remaining: 0, costUsd: 0 };
  const apiKey = options.apiKey ?? process.env.SONIOX_API_KEY;
  if (!apiKey)
    throw new Error("SONIOX_API_KEY is required for usage reconciliation");
  const byReference = new Map<string, Attempt>();
  for (const attempt of attempts) {
    const reference = JSON.parse(attempt.metadata).operationId;
    if (typeof reference !== "string") continue;
    if (byReference.has(reference))
      throw new Error("Duplicate local Soniox operation ID");
    byReference.set(reference, attempt);
  }
  const now = options.now ?? new Date();
  const start = Date.parse(attempts[0]!.started_at);
  if (now.getTime() - start > 31 * 86400_000)
    throw new Error(
      "Reconcile a date-scoped database: Soniox usage windows are limited to 31 days",
    );
  const query = new URLSearchParams({
    start_time: new Date(start).toISOString(),
    end_time: now.toISOString(),
    limit: "1000",
    sort: "end_time_asc",
  });
  const updates = new Map<
    string,
    {
      attempt: Attempt;
      log: Record<string, unknown>;
      cost: number;
      input: number;
      output: number;
    }
  >();
  const cursors = new Set<string>();
  for (;;) {
    const response = await (options.fetch ?? fetch)(
      `https://api.soniox.com/v1/usage-logs?${query}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`Soniox usage request failed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      usage_logs?: Record<string, unknown>[];
      next_page_cursor?: string | null;
    };
    if (!Array.isArray(body.usage_logs))
      throw new Error("Invalid Soniox usage response");
    for (const log of body.usage_logs) {
      const attempt = byReference.get(String(log.client_reference_id));
      if (!attempt) continue;
      const metadata = JSON.parse(attempt.metadata);
      if (
        log.model !== attempt.model ||
        (metadata.transcriptionId && metadata.transcriptionId !== log.uuid)
      )
        throw new Error(
          "Soniox usage identity does not match the recorded attempt",
        );
      const cost = Number(log.cost_usd);
      const counts = [
        log.input_audio_tokens,
        log.input_text_tokens,
        log.output_audio_tokens,
        log.output_text_tokens,
      ];
      if (
        typeof log.cost_usd !== "string" ||
        !/^\d+(\.\d+)?$/.test(log.cost_usd) ||
        !Number.isFinite(cost) ||
        counts.some(
          (n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0,
        )
      )
        throw new Error("Invalid Soniox cost or token counts");
      if (updates.has(attempt.id))
        throw new Error("Ambiguous duplicate Soniox usage entries");
      updates.set(attempt.id, {
        attempt,
        log,
        cost,
        input: Number(log.input_audio_tokens) + Number(log.input_text_tokens),
        output:
          Number(log.output_audio_tokens) + Number(log.output_text_tokens),
      });
    }
    const cursor = body.next_page_cursor;
    if (!cursor) break;
    if (cursors.has(cursor) || cursors.size >= 100)
      throw new Error("Invalid or excessive Soniox usage pagination");
    cursors.add(cursor);
    query.set("cursor", cursor);
  }
  let reconciled = 0,
    costUsd = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { attempt, log, cost, input, output } of updates.values()) {
      const metadata = {
        ...JSON.parse(attempt.metadata),
        costStatus: "provider_reported_usage",
        billingSource: "https://api.soniox.com/v1/usage-logs",
        reconciledAt: now.toISOString(),
        sonioxUsageLog: log,
      };
      const result = db
        .prepare(
          "UPDATE api_calls SET input_tokens=?,output_tokens=?,cost_usd=?,metadata=? WHERE id=? AND status='completed' AND cost_usd IS NULL",
        )
        .run(input, output, cost, JSON.stringify(metadata), attempt.id);
      reconciled += Number(result.changes);
      if (result.changes) costUsd += cost;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { reconciled, remaining: attempts.length - reconciled, costUsd };
}
