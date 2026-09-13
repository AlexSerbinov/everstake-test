import type { Receipt } from "../../../src/contracts.js";
import {
  button,
  details,
  el,
  getJson,
  metric,
  money,
} from "../../shared/dom.js";
import { receiptAttempts, type ReceiptAttempt } from "./receipt-attempts.js";
export function costReceipt(
  receipt: Receipt & { attempts?: ReceiptAttempt[] },
  title = "Answer receipt",
): HTMLElement {
  const content = el("div", "receipt-grid");
  content.append(
    metric(
      "Known cost",
      money(receipt.knownCostUsd),
      receipt.unknownCalls
        ? `${receipt.unknownCalls} calls have unconfirmed cost`
        : "Recorded provider usage",
    ),
    metric("Model calls", String(receipt.calls)),
    metric(
      "Input / output tokens",
      `${receipt.inputTokens.toLocaleString()} / ${receipt.outputTokens.toLocaleString()}`,
    ),
    metric("Server time", `${(receipt.elapsedMs / 1000).toFixed(1)}s`),
  );
  const box = details(
    `${title} · ${money(receipt.knownCostUsd)}${receipt.unknownCalls ? " + unconfirmed charges" : ""}`,
    content,
    el(
      "p",
      "muted small",
      `Run ${receipt.runId}. Server time excludes the browser’s connection and display time.`,
    ),
  );
  const calls = el("div");
  const showCalls = button(
    "View individual calls and retries",
    async () => {
      showCalls.disabled = true;
      try {
        const detail = receipt.attempts
          ? receipt
          : await getJson<Receipt & { attempts: ReceiptAttempt[] }>(
              `/api/receipts/${encodeURIComponent(receipt.runId)}`,
            );
        calls.replaceChildren(receiptAttempts(detail.attempts ?? []));
      } catch (error) {
        calls.replaceChildren(
          el("p", "error-text small", (error as Error).message),
        );
        showCalls.disabled = false;
      }
    },
    "text-button",
  );
  box.append(showCalls, calls);
  return box;
}
