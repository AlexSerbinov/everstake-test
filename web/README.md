# Browser application

`app.ts` mounts the navigation and connects the question form, streamed research, final answer and saved-data pages. Feature folders correspond to visible screen areas. Shared contracts are type-only imports; server code is not bundled.

- `transport/read-run-stream.ts`: POST SSE, streaming UTF-8, frame boundaries, event-ID deduplication, terminal handling and reader cleanup.
- `run-state.ts`: invalidates callbacks from cancelled or replaced requests.
- `shared/dom.ts`: text-only DOM construction and allowlisted links.
- `features/`: question, live search, answer, sources, checks, evidence score, costs, evaluation, collection and errors.

Build with `npm run build:web`. Run browser-unit tests with `npx tsx --test --test-concurrency=1 "web/**/*.test.ts"`. Browser smoke tests should use an isolated local fixture server: reading saved pages is free and asking a real question may be billed.

Public text and URLs are untrusted. Do not insert corpus content with innerHTML. Published, updated and checked dates stay separate. Citation numbers are display labels mapped to stable passage IDs, never array positions received from the model.

## Verification performed

- The unit suite covers byte-by-byte UTF-8/CRLF streams, event deduplication, terminal/error receipts, interrupted streams, cancellation cleanup, old-run isolation, timer cleanup, arbitrary citation IDs, same-page grouping, safe links, and evaluation filters.
- An isolated local fixture server was exercised with `agent-browser` at 1440 × 1100 and 390 × 844. The fixture covered a successful answer, repeated evidence, two passages from one page, an unknown publication date, a long source URL, source text containing an HTML injection, a provider error with receipt, mixed/unassessed evaluation rows, and unknown costs.
- Browser checks confirmed no horizontal overflow on the four views, citation click/Enter focus on the exact passage, preserved original URL anchors, no execution of source HTML, no success panels after provider failure, and replacement/cancellation of active questions.
- These are interface and transport checks using synthetic data. They do not measure model correctness or production proxy streaming.

## Design system

The interface follows the owner's Claude Design Everstake reference: mint surfaces, forest-green accents, square borders, Manrope headings, DM Sans body text, desktop sidebar and a compact mobile menu. The external preview runtime and its unrelated dark-theme bundle are not dependencies.

All five routes retain their real API behavior. Homepage statistics distinguish current documents, saved evaluation accuracy and all-time measured costs. Answer actions copy the displayed dated claims with source references or download the returned evidence as JSON; they do not create a public permalink. Unknown fact dates, unconfirmed charges and provider errors remain explicit. Responsive and fixture verification is recorded in [the redesign review](../docs/review-logs/2026-09-13-ui-redesign.md).
