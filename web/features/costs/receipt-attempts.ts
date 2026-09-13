import { el, money } from "../../shared/dom.js";
export interface ReceiptAttempt {
  id: string;
  stage: string;
  provider: string;
  model: string;
  attempt: number;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  status: string;
}
export function receiptAttempts(attempts: ReceiptAttempt[]): HTMLElement {
  const content = el("div", "attempts");
  if (!attempts.length)
    content.append(
      el("p", "muted small", "No model calls were recorded for this run."),
    );
  for (const attempt of attempts) {
    const line = el("div", "attempt");
    line.append(
      el(
        "strong",
        "",
        `${attempt.stage.replaceAll("_", " ")} · attempt ${attempt.attempt}`,
      ),
      el(
        "p",
        "small muted",
        `${attempt.model} · ${attempt.status} · ${(attempt.elapsedMs / 1000).toFixed(1)}s`,
      ),
      el(
        "span",
        "",
        attempt.costUsd === null ? "Cost unconfirmed" : money(attempt.costUsd),
      ),
      el(
        "p",
        "small muted",
        `Tokens: ${attempt.inputTokens ?? "unknown"} in / ${attempt.outputTokens ?? "unknown"} out`,
      ),
    );
    content.append(line);
  }
  return content;
}
