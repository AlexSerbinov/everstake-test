# YouTube evidence

`screen-videos.ts` separates publisher identity from name similarity. `transcribe-video.ts` uploads accepted audio to Soniox, persists job IDs, resumes polling and preserves timed speaker turns. `review-speakers.ts` performs identity, role-at-recording and contextual label review in one metered Gemini call. A text review cannot prove acoustic identity; suspicious intervals remain visible for review. Raw turns are never overwritten by model conclusions.

The original TypeScript Soniox workflow informed this implementation. API contract and model were checked against https://soniox.com/docs/stt/async/async-transcription on 2026-09-13. https://soniox.com/pricing describes token-based billing; the approximate hourly number is only a planning forecast. Actual provider usage/billing must be reconciled separately when the transcription response does not expose billed tokens.
