# YouTube evidence

`screen-videos.ts` separates publisher identity from name similarity. `transcribe-video.ts` uploads accepted audio to Soniox, persists provider and client-reference IDs before polling, reconciles ambiguous submissions, resumes the same job, and preserves timed speaker turns. `review-speakers.ts` performs identity, role-at-recording and contextual label review in one metered Gemini call. A text review cannot prove acoustic identity; suspicious intervals remain visible for review. Raw provider responses stay in ignored runtime storage and model conclusions never overwrite them.

Run `npx tsx scripts/youtube.ts inventory` to merge and re-screen the legacy 128-row manifest and the fresh official-channel list. Run `pilot` for the configured three-video sample, or `process --ids=id1,id2` for an explicit accepted subset. There is deliberately no process-all command. Runtime credentials are `SONIOX_API_KEY`, `GEMINI_API_KEY`, and optionally `YT_PROXY`, `YT_COOKIES_FILE`, `YT_JS_RUNTIMES`, and `YT_DLP_BIN`.

The Soniox REST contract and `stt-async-v5` model were checked against the official async transcription documentation on 2026-09-13. The configured $0.10/hour amount is a planning forecast. Actual provider cost stays unknown in the ledger when the response exposes duration but no billed amount; it is never recorded as zero.
