# Transport: turn streamed HTTP bytes into run events

Start with [read-run-stream.ts](read-run-stream.ts). `readRunStream()` receives the response to `POST /api/ask` from [app.ts](../app.ts), decodes Server-Sent Events (SSE), and delivers each event to the active question's callback.

It handles partial UTF-8 characters and event frames across network chunks, ignores repeated event IDs, and rejects events from a different run. An `error` event may be followed by a receipt, so reading continues until `done`. A connection that ends without `done` or an error is reported as interrupted. Cancellation releases the stream reader.

[read-run-stream.test.ts](read-run-stream.test.ts) exercises framing, duplicate events, errors, and cleanup using synthetic streams. It does not need the browser or a provider request.

This folder transports progress and results. [The server](../../src/README.md) runs research and validates the answer; [Ask](../features/ask/README.md) renders what the server returns.
