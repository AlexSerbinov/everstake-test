import type { RunEvent } from "../../src/contracts.js";

/** POST SSE, with streaming UTF-8 decoding and explicit terminal-event handling. */
export async function readRunStream(
  response: Response,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    let message = `Request failed (${response.status}). Please try again.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === "string") message = body.error;
    } catch {
      /* Preserve HTTP context. */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("No response stream was received.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let sawError = false;
  let runId: string | undefined;
  const seen = new Set<string>();
  const consume = (frame: string) => {
    if (!frame.trim() || terminal) return;
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return; // Comments and keepalive frames do not imply research progress.
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object")
      throw new Error("The response contained an invalid event.");
    const event = parsed as RunEvent;
    if (
      !["step", "sources", "verification", "answer", "error", "done"].includes(
        event.type,
      ) ||
      typeof event.runId !== "string"
    )
      throw new Error("The response contained an invalid event.");
    runId ??= event.runId;
    // The HTTP adapter uses this sentinel when an unexpected failure occurs after a run started.
    if (
      event.runId !== runId &&
      !(event.type === "error" && event.runId === "request-error")
    )
      return;
    const eventId = lines
      .find((line) => line.startsWith("id:"))
      ?.slice(3)
      .trim();
    if (eventId && seen.has(eventId)) return;
    if (eventId) seen.add(eventId);
    onEvent(event);
    if (event.type === "error") sawError = true;
    terminal = event.type === "done";
  };
  const aborted = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    while (!terminal) {
      if (signal?.aborted)
        throw new DOMException("Request cancelled", "AbortError");
      const { done, value } = await reader.read();
      if (signal?.aborted)
        throw new DOMException("Request cancelled", "AbortError");
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consume(frame);
      }
      if (done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!terminal && !sawError)
      throw new Error(
        "The connection ended before the answer finished. Please try again.",
      );
  } finally {
    signal?.removeEventListener("abort", aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
