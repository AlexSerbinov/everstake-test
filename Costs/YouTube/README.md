# YouTube cost ledger

`ledger.json` is generated from `data/youtube.sqlite` by `npx tsx scripts/youtube.ts export`. Provider calls are recorded before submission. Gemini token costs use provider-reported usage and the dated price table. Soniox responses do not expose a billed amount, so those rows keep `cost_usd: null`; their configured duration forecast remains in `metadata.reservationUsd` for budget enforcement.

The three-video pilot contains 1,607 seconds of audio. Its Soniox forecast is $0.04463889. The three Gemini speaker-review calls reported 13,241 input tokens, 2,980 output tokens, and $0.02110575 measured cost. Forecast/reserved plus known cost is $0.06574464, below the $1 pilot ceiling.

The importer found 186 distinct videos across the 128-row legacy manifest and the 97-row live official-channel list. Screening yielded 77 accepted, 72 requiring review, and 37 excluded. Only the three explicit pilot videos were processed; an operator must review/select further IDs before another paid run.
