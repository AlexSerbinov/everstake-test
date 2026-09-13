# YouTube: speakers, evidence and readable transcripts

- [Readable transcripts and speaker tables](../../artifacts/youtube/reviewed/README.md)
- [Machine-readable review manifest](../../artifacts/youtube/reviewed/manifest.json)
- [Measured processing costs](../../Costs/YouTube/README.md)
- [Topic-aware retrieval design](../YOUTUBE_KNOWLEDGE.md)

## What enters search

Soniox preserves timestamped dialogue and anonymous speaker labels. Gemini 3.8 Flash reviews the complete dialogue for named identities, recording-time roles, affiliation, label consistency and non-evidence turns. Explicit self-identification or a linked host introduction and guest response support attribution. Metadata alone cannot map a person to an anonymous label.

Full dialogue remains in the readable export. The corpus receives only named company participants' eligible testimony. Interviewer and third-party turns, unknown identities, questions, hypothetical/quoted/retracted assertions and suspicious intervals cannot enter this evidence export. A mixed turn can be excluded in full; this deliberately sacrifices coverage rather than indexing a rejected premise. Text-only model classification is imperfect and is not an acoustic identity guarantee.

Every embedding passage repeats the recording timestamp, speaker and role. Source links seek to that point in the video. Upload dates remain distinct from recording dates and current employment. Speaker authority does not prove a statement true; recency, conflicts and ordinary evidence validation still apply.

## Files and repeatable commands

- `data/youtube/<video-id>.job.json`: cached Soniox result, never renamed or retranscribed for display changes.
- `data/youtube/<video-id>.review-v2.json`: model review, cached by transcript/metadata/model/prompt hash.
- `artifacts/youtube/transcripts/`: original anonymous transcript exports.
- `artifacts/youtube/reviewed/`: date-role-surname-given-name-topic-ID Markdown/JSON exports with names, roles and eligibility.
- `scripts/review-youtube.ts --ids=...`: review existing audio transcripts, record model usage and regenerate readable exports.

Internal IDs and citation URLs remain stable. Human-readable filenames are display artifacts; the README links them by title. Unknown people remain explicitly unknown rather than receiving an invented name.

## Review limitations and corrections

Model-reviewed does not mean every speaker is named. Anonymous hosts, brief panel interjections and conflicting roles remain explicit. Current activation is deliberately conservative: a `needs_review` recording stays outside the factual index even when some names were identified. Full named transcripts still remain readable. Editorial spelling corrections use supplied video metadata only after dialogue establishes the identity; they never rewrite the original spoken text. See [attribution QA](ATTRIBUTION_QA.md).

Activation stages all YouTube chunks and embeddings before changing the active source. Failed embedding calls remain in the cost ledger and leave the previous source active. Only YouTube source documents are replaced; the rest of the corpus is retained. The existing twenty-question evaluation remains tied to its stated frozen corpus, not automatically re-certified by this update.

## Verified deployment

18 readable reviews; 6 eligible source documents with 189 embedding passages. Ten recordings remain `needs_review`; two reviewed recordings have no eligible named company testimony. The active corpus retains 935 non-YouTube documents (941 total). 117 tests pass on the server. A live CCN question returned an attributed answer and a source link at 4:12; repeated activation reused all embeddings without additional calls. [Saved smoke test](../../artifacts/youtube/reviewed/live-smoke-test.json).

Display names use **upload date → recording-time role → surname and given name → original topic/title**. For example: `2026-04-23 — COO — Opryshko Bohdan — …`. Stable YouTube IDs stay at the end of filenames. Unconfirmed roles are explicitly marked; raw video titles and original transcript text remain preserved inside the export. The same names are published in Git and in source-card titles.
