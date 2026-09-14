# Browser application

`app.ts` mounts the navigation and connects the question form, streamed research, final answer and saved-data pages. The six feature folders match the six navigation pages; everything used to ask and display one answer is together in `features/ask/`. Shared contracts are type-only imports; server code is not bundled.

## Follow one question

`app.ts:ask()` starts a `RunState` generation, sends `POST /api/ask`, and passes the response to `readRunStream()`. The transport decodes SSE frames, ignores duplicate event IDs, and invokes the run's event handler. Progress updates go to `SearchTimeline`; an `answer` event renders `answerView()` and enables exports from that returned result. An `error` event can arrive before the final answer/receipt, so it does not terminate stream reading; `done` does.

`RunState.start()` aborts the previous fetch and gives callbacks a `current()` guard. Cancellation also changes the generation because an already-resolved callback can arrive after abort. `ask()` checks ownership before rendering and before unlocking the form. The Stop button, `newQuestion()`, and `pagehide` cancel work; switching application routes preserves the question node and its active run. Browser cancellation cannot undo provider calls already started.

`navigate()` selects the page for the hash route. Updates is the only page that polls: navigation calls its `destroy()` to clear the timer and abort status requests. Server update jobs continue independently.

## Code map

| Start here | What it owns |
| --- | --- |
| `app.ts`: `ask()`, `newQuestion()`, `navigate()` | Request lifecycle, route mounting, answer exports, page disposal |
| `run-state.ts`: `RunState.start()`, `cancel()` | Active request ownership and cancellation |
| `transport/read-run-stream.ts`: `readRunStream()` | Streaming UTF-8, SSE framing, event deduplication, terminal handling, reader cleanup |
| `shared/dom.ts`: `el()`, `link()`, `getJson()` | Text-only DOM construction, allowlisted source links, internal JSON reads |
| `features/ask/question-form.ts`: `questionForm()` | Question input and busy state |
| `features/ask/answer-view.ts`: `answerView()` | Returned status, dated claims, sources, checks, evidence score, and receipt |
| `features/ask/citation-navigation.ts` | Citation labels and passage focus using stable evidence IDs |
| `features/corpus/corpus-page.ts`: `corpusPage()`, `appendDocument()` | Server-side search/pagination and saved document excerpts; generation IDs reject stale responses |
| `features/updates/updates-page.ts`: `updatesPage()` | Status polling, editable settings draft, explicit queue/save requests; nested `load()`, `mutate()`, and `poll()` separate these operations |
| `features/costs/cost-overview.ts`: `costOverview()` | Saved accounting dashboard; `providerBreakdown()` renders provider totals, `corpusForecast()` renders projections, `renderLedger()` filters recorded operations |
| `features/evaluation/evaluation-page.ts`: `evaluationPage()` | Saved runs, comparison selection, and display filters |
| `features/evaluation/current-evaluation.ts`: `publicEvaluations()` | Published run selection and a labelled combined view of saved rechecks |
| `features/findings/findings-page.ts`: `findingsPage()` | Readable project documents from the published findings catalog |

Corpus, costs, and evaluation views fetch recorded data; they do not start model calls. Cost totals and evaluation verdicts come from the server's saved records. Cost filters change the displayed subtotal; evaluation filters change rows only, preserving full-run metrics. The 50× cost section is a forecast, not measured spending. Updates keeps unsaved form settings separate from polled saved status; only an explicit action queues processing or saves settings.

Build with `npm run build:web`. Run browser-unit tests with `npx tsx --test --test-concurrency=1 "web/**/*.test.ts"`. Browser smoke tests should use an isolated local fixture server: reading saved pages is free and asking a real question may be billed.

Public text and URLs are untrusted. Do not insert corpus content with innerHTML. Published, updated and checked dates stay separate. Citation numbers are display labels mapped to stable passage IDs, never array positions received from the model.

## Verification performed

- The unit suite covers byte-by-byte UTF-8/CRLF streams, event deduplication, terminal/error receipts, interrupted streams, cancellation cleanup, old-run isolation, timer cleanup, arbitrary citation IDs, same-page grouping, safe links, and evaluation filters.
- An isolated local fixture server was exercised with `agent-browser` at 1440 × 1100 and 390 × 844. The fixture covered a successful answer, repeated evidence, two passages from one page, an unknown publication date, a long source URL, source text containing an HTML injection, a provider error with receipt, mixed/unassessed evaluation rows, and unknown costs.
- Browser checks confirmed no horizontal overflow on the four views, citation click/Enter focus on the exact passage, preserved original URL anchors, no execution of source HTML, no success panels after provider failure, and replacement/cancellation of active questions.
- These are interface and transport checks using synthetic data. They do not measure model correctness or production proxy streaming.

## Design system

The interface follows the owner's Claude Design Everstake reference: mint surfaces, forest-green accents, square borders, Manrope headings, DM Sans body text, desktop sidebar and a compact mobile menu. The external preview runtime and its unrelated dark-theme bundle are not dependencies.

All six routes retain their real API behavior. Homepage statistics distinguish current documents, saved evaluation accuracy and all-time measured costs. Answer actions copy the displayed dated claims with source references or download the returned evidence as JSON; they do not create a public permalink. Unknown fact dates, unconfirmed charges and provider errors remain explicit. Responsive and fixture verification is recorded in [the redesign review](../docs/review-logs/2026-09-13-ui-redesign.md).
