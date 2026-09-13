# YouTube cost ledger

`ledger.json` is generated from `data/youtube.sqlite` by `npx tsx scripts/youtube.ts export`. Provider calls are recorded before submission. Gemini token costs use provider-reported usage and the dated price table. Soniox responses did not expose billed amounts, so those rows keep `cost_usd: null`; their duration forecasts remain in `metadata.reservationUsd` for budget enforcement.

The initial three-video pilot contained 1,607 seconds of audio. The manually reviewed follow-up selected three dated interviews, bringing the bounded selection to 9,868 seconds (2.741 hours). Six Soniox jobs and six one-pass Gemini reviews completed. Four reviews produced sanitized documents. Two remained quarantined: one invalid role-only attribution and one review with inconsistent/unsupported attribution. Neither paid Gemini call was retried.

Gemini reported 51,992 input tokens, 7,488 output tokens, and $0.067074 measured cost. Soniox actual cost remains unknown; its duration-based forecast/reservation is $0.27411111. Known cost plus the Soniox reservation is $0.34118511, below the $3 ceiling. This is not presented as $0.34118511 of actual spend because Soniox did not return billing data.

The importer found 186 distinct videos across the 128-row legacy manifest and the 97-row live official-channel list. Initial screening yielded 77 accepted, 72 requiring review, and 37 excluded. Metadata review promoted one named COO interview, producing 78 accepted and 71 requiring review. Six accepted videos were processed, four entered the document export, two were quarantined, and 72 accepted videos remain unprocessed.
