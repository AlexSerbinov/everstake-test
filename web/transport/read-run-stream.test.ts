import { test } from "node:test";
import assert from "node:assert/strict";
import { readRunStream } from "./read-run-stream.js";
import type { RunEvent } from "../../src/contracts.js";
const event = (
  type: RunEvent["type"],
  label = "A step",
  runId = "r1",
): RunEvent => ({ runId, type, at: "2026-09-13T10:00:00Z", label });
const frame = (value: RunEvent, id?: string) =>
  `${id ? `id: ${id}\r\n` : ""}event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
function response(parts: Uint8Array[], onCancel = () => {}) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
      cancel: onCancel,
    }),
  );
}
test("parses every byte boundary, CRLF and split UTF-8 without corrupting text", async () => {
  const bytes = new TextEncoder().encode(
    `: keepalive\r\n\r\n${frame(event("step", "Джерело 🌱"))}${frame(event("done"))}`,
  );
  const received: RunEvent[] = [];
  await readRunStream(
    response([...bytes].map((byte) => new Uint8Array([byte]))),
    (value) => received.push(value),
  );
  assert.deepEqual(
    received.map((row) => row.label),
    ["Джерело 🌱", "A step"],
  );
});
test("deduplicates event IDs, ignores other runs and ignores events after done", async () => {
  const data =
    frame(event("step"), "1") +
    frame(event("step"), "1") +
    frame(event("step", "Stale", "r2"), "2") +
    frame(event("done"), "3") +
    frame(event("step", "Too late"), "4");
  const received: RunEvent[] = [];
  await readRunStream(response([new TextEncoder().encode(data)]), (value) =>
    received.push(value),
  );
  assert.deepEqual(
    received.map((row) => row.type),
    ["step", "done"],
  );
});
test("retains error receipt emitted between error and done", async () => {
  const data =
    frame(event("error", "Provider unavailable")) +
    frame(event("answer", "Failed run receipt")) +
    frame(event("done"));
  const received: RunEvent[] = [];
  await readRunStream(response([new TextEncoder().encode(data)]), (value) =>
    received.push(value),
  );
  assert.deepEqual(
    received.map((row) => row.type),
    ["error", "answer", "done"],
  );
});
test("EOF after explicit error preserves the error, EOF before terminal outcome fails", async () => {
  await readRunStream(
    response([new TextEncoder().encode(frame(event("error")))]),
    () => {},
  );
  await assert.rejects(
    readRunStream(
      response([new TextEncoder().encode(frame(event("step")))]),
      () => {},
    ),
    /connection ended/,
  );
});
test("HTTP errors preserve readable server messages", async () => {
  await assert.rejects(
    readRunStream(
      new Response(JSON.stringify({ error: "Budget limit reached" }), {
        status: 429,
      }),
      () => {},
    ),
    /Budget limit reached/,
  );
});
test("cancellation interrupts a waiting reader and releases the stream", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const reading = readRunStream(
    new Response(stream),
    () => {},
    controller.signal,
  );
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
test("malformed event releases the reader", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: []\n\n"));
    },
  });
  await assert.rejects(
    readRunStream(new Response(stream), () => {}),
    /invalid event/,
  );
  assert.equal(stream.locked, false);
});
