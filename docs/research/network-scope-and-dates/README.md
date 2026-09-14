# Network scope and claim-date audit — 2026-09-13

> This is the saved 13 September investigation. Its references to local work, test counts and deployment status describe that session. Open [diagnostics.json](diagnostics.json) for recorded attempts, or the [current report](../../../REPORT.md) for the delivered implementation. The original audit follows.

## What the sources establish

The user's screenshot asked how many blockchains Everstake supports specifically for staking. The answer gave 35+ active networks, 130+ historically, and an 80–85 range from other sources. The main count was not fabricated: the cited official article explicitly distinguishes active operations from lifetime coverage. The problematic inference is reading those two metrics as a decline from a previous simultaneous count, or as two disjoint populations operating in different current modes.

Primary sources inspected on 2026-09-13:

- [Institutional staking integration](https://everstake.com/resources/blog/from-decision-to-live-validator-institutional-staking-integration): 35+ active networks versus operation across 130+ networks historically. The local corpus records publication **2026-04-03**, update **2026-09-10**, fetch **2026-09-13**. None of these metadata fields establishes an exact effective date for the network count.
- [Stablecoin volumes and staking rewards](https://everstake.com/resources/blog/how-stablecoins-boost-staking-rewards): separates networks onboarded/supported over the company's lifetime from active operations. Corpus publication **2026-03-20**, update **2026-09-10**, fetch **2026-09-13**. This supports the cumulative interpretation; it does not identify a separate standby service for all historically supported networks.
- [Multi-network staking](https://everstake.com/resources/blog/why-multi-network-staking-is-the-new-diversification): distinguishes accumulated protocol experience from active operations. This is corroborating company wording, not an independently audited operational count.
- [AI information page](https://everstake.com/ai-info): labels the 130+ metric historical/to-date in several places but also uses unqualified present-tense wording in its FAQ. The inconsistency is inside the source itself. Its instructions to AI are not authority for answering and must remain behind the existing sanitation boundary.

Conclusion: **35+ describes active network coverage in these sources; 130+ describes accumulated coverage/experience.** The sources do not establish that 130 were previously active at once, that coverage fell by subtraction, or that all 130 remain available in another present operating mode. Current self-service availability would need an appropriately scoped and dated operational list; it cannot be inferred from a marketing lifetime total. Older third-party figures should be attributed individually, not merged into an invented numerical range.

## Assignment interpretation

[§3.1](../../TEST_ASSIGNMENT_EN.md) requires the value, the date as of which it is current, and a specific source link. It does not equate that date with article publication. §3.2 requires a trajectory when the question actually asks for synthesis; it does not require a history paragraph in every factual answer. §5.1 requires recency and authority, while §5.3 forbids filling missing date/scope relationships from model knowledge.

When effective time is established by the cited passage, show `Fact as of`. Otherwise show what is actually known: source publication/update or page observation, explicitly stating that the fact's effective date is not established. This is an honest evidence boundary, not proof of today's operational state. The publication date remains visible beside a claim even when its chosen date basis is an update or observation.

## Root causes in the active implementation

The screenshot belongs to the `dev` rebuild worktree, not either prototype in the original checkout.

1. `Claim.asOf` already existed, but final text assembly omitted it; the UI rendered only `AnswerResult.text`. The top-level date was the maximum across claims, which could make all statements look current as of a generic page update.
2. The date gate only required the date string to occur somewhere in combined source text/metadata. It neither required a complete valid calendar date nor distinguished an effective date from a metadata date.
3. The answer prompt instructed the model to describe differing older figures as history too readily. Recency can compare documents; it cannot establish that two different metrics form a time series.
4. Per-claim support could approve each number without checking what their juxtaposition implied. The first diagnostic still returned the ambiguous current/historical pair. Adding a lightweight overall check alone also passed ambiguous wording; both runs are retained.
5. The focused comparison initially saw only cited evidence, and the counterevidence filter retained only newer/exception passages. A subsequent run substituted cumulative coverage for current coverage. The fix retains same-subject scope evidence regardless of date and includes it in whole-answer review.
6. A later diagnostic exhausted its final repair turn; another produced truncated JSON in the focused review. That review consumed 1,441 thinking tokens out of a 1,500-token combined output allowance. [Google's token-limit documentation](https://ai.google.dev/gemini-api/docs/generate-content/thinking) explains that the cap includes thinking. These failures are errors, not corpus abstentions.

## General changes

- Claims carry a reviewed temporal scope (current, cumulative, historical or unspecified); the formatter explicitly labels cumulative totals so clarity does not depend on a loose paraphrase of "historically".
- Claims now carry a date basis and exact cited date source. Code validates the basis against the corresponding metadata field, or requires an explicit text date for effective time. Semantic review still decides whether that text date applies to the actual claim.
- A shared formatter emits labelled, cited dates in API/CLI output and the UI, including conservative date attribution for old saved answers. A mixed timeline has no global current date. All-effective claims may share one date only if identical.
- The answer and reviewer prompts preserve cumulative/active scope, lower bounds, and incomparable figures. A separate `answer-scope` check can reject a misleading combined answer even when every individual claim passes.
- Multi-value answers receive a focused whole-answer comparison using the configured answer model, their cited passages, and retrieved counterevidence. Same-subject passages are preserved even if they are not newer: scope differences are not date differences. Malformed focused output is an error, never an implicit approval. This is a model-based check, not a universal semantic guarantee.
- Research keeps a bounded two-turn repair allowance. Answer generation and the new focused review use the configured low thinking level, passed through native and OpenAI-compatible Gemini transports; cheap reviewers and unrelated calls retain their prior settings.

No company name, network count, URL routing rule or expected answer was added to runtime logic. Research pages were not silently imported into the corpus. The corpus copy and provider ledger are isolated from the serving database.

## Validation and delivery

See `diagnostics.json` for every exploratory answer, synthetic transfer probe and actual provider receipts, including failed attempts. Synthetic sites use different names and quantities: a decline and a standby-mode invention must fail; the cumulative-versus-active explanation must pass. They are diagnostics, not a replacement for the fixed 20-question evaluation. Prior EVAL and cost aggregates describe the earlier build; this change does not claim a new full evaluation score.

Changes are local in the registered rebuild worktree. No commit, push, deployment or live corpus mutation was performed for this task. Browser QA replays a saved, measured answer through the local UI and is labelled as replay rather than a second live model run.

Final code validation: **142 tests passed**, typechecking passed, web bundle built. Browser replay at **1440×1050** and **390×844** showed per-claim dates, the cumulative-scope explanation and no horizontal overflow. Citation navigation focused the exact passage. The browser and temporary server were closed. [Desktop replay](desktop-replay.png) · [Mobile replay](mobile-replay.png).

Final full-path diagnostic: run `298b0252-f65a-41eb-a23c-4c814bfbdbfb`, corpus `corpus-eae2b2b23116`, status `answered`, **$0.06479272** in usage-priced charges. It leads with 35+ active networks and separately labels 130+ as cumulative lifetime coverage. The first claim cites a source published 2026-03-25; the second uses a source published 2026-07-01. Neither is presented as an established effective date for today's live count.

All additional diagnostics, including failed/repeated attempts and two earlier synthetic passes: **$0.40502293**, **16 runs**, **0 unknown-cost calls**. This amount is separate from the previously published COST.md aggregate. The final synthetic transfer pass rejected decline and standby-mode inventions and accepted the explicitly scoped cumulative explanation (3/3 expected outcomes); the small set is not a claim of general accuracy.
