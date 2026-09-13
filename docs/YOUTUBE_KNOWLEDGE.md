# Video knowledge: transcripts, search notes and grounded answers

Status: named-speaker review, readable exports and evidence-only indexing are implemented; see [the YouTube guide](youtube/README.md). Topic-note generation and navigation-note retrieval below remain design recommendations. Full transcripts preserve dialogue; only eligible attributed testimony enters the evidence index.

## Why transcript embeddings alone can miss the question

Embeddings can match meaning without the exact word "positioning". The harder problem is that an interview scatters the answer across examples: enterprise clients, custody requirements, a new product, an older business model, and a future plan. A short isolated chunk can lose this relationship. Replacing the transcript with a summary would lose the evidence and its corrections.

Use two searchable representations of the same source: original timed passages and a compact navigation note. Keep one evidence identity per video. A generated note is a search aid, never an independent factual source or an extra vote.

## Files a reviewer can understand

```text
artifacts/youtube/
  transcripts/<video-id>.md       readable complete transcript, anonymous speakers
  transcripts/<video-id>.json     timed turns and source metadata
  navigation/<video-id>.md        reviewed topic map, linked to original turn IDs
src/services/youtube/
  transcribe-video.ts            Soniox jobs, cache and resume
  render-transcript.ts           raw timed text to readable Markdown
  review-speakers.ts             named identity and role checks
  build-navigation.ts            proposed: small source-linked search note
  search-navigation.ts           proposed: notes to original passage candidates
```

Original Soniox token responses and audio remain in the runtime data directory. Markdown is a readable export; JSON/SQLite holds stable IDs and structured fields. Do not maintain conflicting handwritten copies of the same facts.

## One navigation note per video

Include title, publisher, upload date, known recording date, reviewed speakers and their role at recording, a short neutral overview, several topics, and relevant turn ranges. Topics are open-ended concepts extracted from content; company history, institutional adoption, validator operations and customer experience are examples, not a closed classifier or question-specific routes.

For each section store: concept, brief description, original video ID, start/end turn IDs, source timestamps, and epistemic status (speaker claim, interviewer question, correction, future intention, uncertainty). Describe an aspiration as an aspiration. Preserve the question and correction together when a guest rejects a suggested fact. Never infer an executive's identity solely from an unassigned Soniox label. A panel participant cannot become a company spokesperson merely by sharing a stage with one.

Potential search descriptions can explain that a passage concerns a change from retail staking toward institutional infrastructure even when the exact word "positioning" is absent. Such interpretation helps locate evidence; the final answer must independently read and check the original passages. A misleading generated heading cannot authorize a claim.

## Retrieval and answering

1. Search original passages and navigation notes with the existing lexical/embedding approach. The task can express a date range, subject and question intent without hardcoded names or a fixed CEO/synthesis keyword list.
2. A note hit resolves to its linked original turn ranges, with nearby dialogue included. Do not send only a summary to the answer model.
3. For history, retrieve several dated observations across relevant periods, including older interviews. For present-state questions, select evidence appropriate to current scope and retain conflicting observations.
4. Generate and verify claims against source passages. Cite the YouTube URL with its timestamp. Display upload date separately from recording date; neither automatically proves when a business change took effect.
5. Deduplicate transcript/note hits using the same video ID. Notes do not contribute additional source authority, independent-source count or Trust Score. A cross-video timeline is a view assembled from cited evidence, not a new authoritative source.

Source authority depends on speaker, claim and context rather than platform alone. A named founder's retrospective account can be first-person evidence about company history; an old interview does not override more relevant current product documentation. Questions, third-party claims and quoted claims retain their own attribution.

## Safe update and costs

Key each generated artifact by video ID, audio/transcript content hash, model and prompt/schema version. Reuse successful Soniox jobs. Review speakers and generate a small note once per changed source; do not repeat these steps on every user query. Sanitize AI-directed instructions before model/index input, while retaining the original acquisition files separately for audit. Unverified transcripts stay outside the active factual corpus.

Report separate stages: Soniox transcription, Gemini speaker review, navigation-note generation and embeddings. Duration × $0.10/hour is a forecast, not a measured invoice. Soniox's public async pricing is token-based: $1.50 per million input audio tokens, $3.50 per million input text tokens and $3.50 per million output text tokens (checked 2026-09-13 at https://soniox.com/pricing). Use `GET /v1/usage-logs` to reconcile native costs by recorded `client_reference_id` and transcription UUID. This reconciliation is implemented as `npx tsx scripts/youtube.ts reconcile-costs --db=...`; unrelated usage is not imported. Otherwise retain null actual charges and an explicit forecast. Paid review/note generation needs its own recorded usage.

## Small validation before expanding the design

Use questions about company origins, change in customer focus, product evolution, present positioning and an absent fact. Include one interviewer correction and one old fact that differs from a newer source. Compare raw-passage retrieval against passage-plus-note retrieval: did it find the necessary original evidence, keep the date/speaker correct, avoid unsupported conclusions, and what did it cost? Keep the frozen twenty-question evaluation unchanged until an explicit new corpus/version run; do not build topic notes from reference answers.

Start with per-video notes. Add a cross-video timeline only if measured retrieval failures justify it. No graph database, separate synthesis service or manually maintained "true company history" is required for this demo.
