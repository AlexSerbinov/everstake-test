# YouTube evidence

`screen-videos.ts` separates publisher identity from name similarity. `transcribe-video.ts` uploads accepted audio to Soniox, persists provider and client-reference IDs before polling, reconciles ambiguous submissions, resumes the same job, and preserves timed speaker turns. `review-speakers.ts` performs identity, role-at-recording and contextual label review in one metered Gemini call. A text review cannot prove acoustic identity; suspicious intervals remain visible for review. Raw provider responses stay in ignored runtime storage and model conclusions never overwrite them.

Run `npx tsx scripts/youtube.ts inventory` to merge and re-screen the legacy 128-row manifest and the fresh official-channel list. Run `pilot` for the configured three-video sample, or `process --ids=id1,id2` for an explicit accepted subset. There is deliberately no process-all command. Runtime credentials are `SONIOX_API_KEY`, `GEMINI_API_KEY`, and optionally `YT_PROXY`, `YT_COOKIES_FILE`, `YT_JS_RUNTIMES`, and `YT_DLP_BIN`.

`rebuild-documents` recreates sanitized snapshots from completed jobs and persisted reviews without provider calls. Third-party interviews become authority tier 2 only when a reviewed, named speaker has an evidenced Everstake role. Metadata explicitly limits that tier to the participant's statements; interviewer questions remain context. Official-channel sources retain tier 1 even when the narrator is unidentified.

`npx tsx scripts/import-youtube.ts --source=... --target=... --documents=... --dry-run` checks an import without writing. Omitting `--dry-run` atomically imports runs, API calls, jobs, and inactive snapshots. Existing equal rows are skipped; any same-ID/different-content row aborts the whole transaction. It never creates chunks or embeddings.

The Soniox REST contract and `stt-async-v5` model were checked against the official async transcription documentation on 2026-09-13. The configured $0.10/hour amount is a planning forecast. Actual provider cost stays unknown in the ledger when the response exposes duration but no billed amount; it is never recorded as zero.
