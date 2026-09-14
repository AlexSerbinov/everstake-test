# YouTube evidence

`screen-videos.ts` separates publisher identity from name similarity. `transcribe-video.ts` uploads accepted audio to Soniox, persists provider and client-reference IDs before polling, reconciles ambiguous submissions, resumes the same job, and preserves timed speaker turns. `review-speakers.ts` performs identity, role-at-recording and contextual label review in one metered Gemini call. A text review cannot prove acoustic identity; suspicious intervals remain visible for review. Raw provider responses stay in ignored runtime storage and model conclusions never overwrite them.

## Follow one video through the code

| Step | Start reading here | What it decides or saves |
| --- | --- | --- |
| Discover and screen | `pipeline.ts: importInventory`, `screen-videos.ts` | Merge discovery records and apply the current inclusion policy, even to previously accepted videos. |
| Download | `pipeline.ts: downloadAcceptedAudio` | Reuse cached audio for accepted videos; use a temporary cookie copy if authentication is configured. |
| Transcribe or resume | `transcribe-video.ts: transcribeVideo` | Check audio/model identity, resume an existing provider job, and preserve the raw transcript. |
| Review speakers | `review-speakers.ts`, `review-cache.ts` | Attach evidenced identities and roles; cache results by input, model and prompt. |
| Select testimony | `evidence-turns.ts: isEvidenceEligible` | Exclude unreviewed, suspicious and non-employee turns from factual evidence. |
| Build a document | `pipeline.ts: buildDocument` | Format eligible testimony, strip AI instructions, and attach dates and authority. |
| Activate | `activate-reviewed.ts` | Index eligible testimony and record the additional embedding usage. |

Three IDs in transcription serve different purposes: the **video ID** locates the saved local job; the **client reference** lets us find a submission after a lost response; the **transcription ID** resumes polling that same Soniox job. Audio hash and model must also match before reuse. A timeout means we stopped waiting, not that the paid job vanished. A completed cached transcript can have its turn formatting rebuilt locally without buying another transcription.

Speaker eligibility and document authority answer different questions. Eligibility decides which words can become evidence. Authority describes their source. An official channel does not make every voice in its video an employee. The upload date is also not assumed to be the recording date.

## Operator commands and cost evidence

Run `npx tsx scripts/youtube.ts inventory` to merge and re-screen the legacy 128-row manifest and the fresh official-channel list. Run `pilot` for the configured three-video sample, or `process --ids=id1,id2` for an explicit accepted subset. There is deliberately no process-all command. Runtime credentials are `SONIOX_API_KEY`, `GEMINI_API_KEY`, and optionally `YT_PROXY`, `YT_COOKIES_FILE`, `YT_JS_RUNTIMES`, and `YT_DLP_BIN`.

`rebuild-documents` recreates sanitized snapshots from completed jobs and persisted reviews without provider calls. Third-party interviews become authority tier 2 only when a reviewed, named speaker has an evidenced Everstake role. Metadata explicitly limits that tier to the participant's statements; interviewer questions remain context. Official-channel sources retain tier 1 even when the narrator is unidentified.

`npx tsx scripts/import-youtube.ts --source=... --target=... --documents=... --dry-run` checks an import without writing. Omitting `--dry-run` atomically imports runs, API calls, jobs, and inactive snapshots. Existing equal rows are skipped; any same-ID/different-content row aborts the whole transaction. It never creates chunks or embeddings.

The Soniox REST contract and `stt-async-v5` model were checked against the official async transcription documentation on 2026-09-13. The configured $0.10/hour amount is a planning forecast. Actual provider cost stays unknown in the ledger when the response exposes duration but no billed amount; it is never recorded as zero.


## Save transcripts before named-speaker review

`transcribe --db=data/youtube-batch.sqlite --ids=...` runs only download/Soniox for explicitly screened videos, exporting timed JSON and Markdown to `artifacts/youtube/transcripts/`. It does not call Gemini or add those transcripts to the active factual corpus. A failed video is persisted and the remaining selected videos continue; rerunning the same batch database resumes stored job IDs. Check the shared job registry before starting a new isolated batch database, then import its ledger/jobs with `import-youtube.ts` and an empty documents array. Retain the audio cache for hash-checked reuse.

`reconcile-costs --db=...` fetches Soniox's official usage logs and matches both client operation references and transcription IDs. It stores provider-reported USD and separate native token counts, preserving forecasts and leaving unmatched costs unknown. Repeated reconciliation does not duplicate spend. These queries report existing usage; they do not submit audio.

The source-linked navigation-note proposal for history and positioning is in [YOUTUBE_KNOWLEDGE.md](../../../docs/YOUTUBE_KNOWLEDGE.md). That retrieval layer is a design, not an active feature.

For current named-speaker processing, use `npx tsx scripts/review-youtube.ts --ids=...`. It reuses Soniox transcripts and caches the review by input/model/prompt hash. The `process` and `rebuild-documents` paths also consume this v2 cache; legacy reviews without evidence-scope classification cannot emit testimony. Reviewed files and their reading index are in `artifacts/youtube/reviewed/`. `scripts/activate-youtube.ts` activates only eligible testimony and records incremental embedding costs. See `docs/youtube/README.md`.
