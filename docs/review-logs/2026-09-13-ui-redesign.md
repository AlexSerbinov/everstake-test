# Knowledge Base design-system integration review

Scope: `public/index.html`, `public/style.css`, `web/app.ts`, the question/answer/source/check/research components, and answer exports. Unrelated documentation/image changes in the shared dev checkout are excluded.

Reference: owner's local `Knowledge Base Design System/Everstake Knowledge Base.dc.html`. The bundled `_ds` library belongs to an older dark Trocador theme; only the actual Everstake frame design is used. No preview runtime, fabricated history, permalink, collection freshness, prices or evaluation numbers are imported.

Review: standard General plus Layout QA and browser scenarios. GPT-6 Astra reviewers were explicitly requested by the owner. The server subscription quota gate is scoped to jamal projects; this is a personal project with native collaboration agents.

## Iteration 1 — General

Raw reviewer output:

> **P2 — Focus the question input after route mounting**
> `web/app.ts:156–158`
>
> When “Ask a question” is clicked from Corpus, Costs, Evaluation or Updates, `newQuestion()` changes the hash and immediately calls `form.focus()`. The textarea is still detached until the asynchronous `hashchange` handler runs, so focusing silently fails.
>
> Confirmed against the fixture: immediately after clicking, `questionAttached=false`; after navigation, `questionAttached=true` but `document.activeElement` remains `BODY`. Keyboard users cannot immediately type into the newly opened question form.
>
> Suggested fix: mount the Ask route synchronously before focusing, or queue an explicit focus request consumed by `navigate()` after `root.replaceChildren()`.
>
> No other blocking P0–P2 findings in the reviewed scope. Existing cancellation guards, citation targets, safe URL handling, source numbering and answer export grounding remain intact. CSS was excluded as requested. Independent browser session closed; no files changed.

Fix: replaced immediate `form.focus()` with `focusQuestionAfterNavigation`, consumed after the Ask component mounts. This retains normal hash history and avoids replacing the routing mechanism to solve a focus issue. Browser verification confirms `document.activeElement.id === "question"` after navigation.

Export regression tests cover shared dated-claim rendering, unknown dates and upload-date limitations, separate abstention/error text, stable citation IDs and exclusion of unsafe URL schemes. The initial full typecheck/offline suite passed 144 tests before the five export tests were added.

## Browser verification and fixes

The coordinator exercised Ask at 1440×1000 and 390×844 using the isolated fixture server. Confirmed normal answer, missing-evidence abstention, SSE provider error, stop then replacement, copy confirmation, citation focus on the exact passage, and mobile Menu/Escape. No horizontal overflow or runtime errors occurred. These are synthetic/recorded responses, not new quality measurements.

The error fixture exposed a pre-existing terminal-label bug: after an SSE error, `!receivedAnswer` overwrote “Request failed” with “Research complete”. The final branch now retains “Request failed”; browser assertion confirmed the label.

Layout fixes: `.header-actions .menu-toggle` overrides the generic button display on desktop; the sticky header and sidebar keep navigation reachable; answer scrolling targets the action toolbar. Mobile navigation uses a viewport-height scrolling panel below the 72px header. Verified the menu remained visible at document scrollY=4163 (top=72, bottom=844).

Independent feature QA raw output:

> QA finished, session redesign-qa closed. PASS: Corpus Next 1→2 (939 total), Previous 2→1 disables at boundary; mobile menu closes after Corpus navigation. Costs activity select 'answer', model disclosure, first receipt + individual calls/retries render. Evaluation agent default 95%/19/20; fail filter only E05 while metrics unchanged; expected/system/assessment expansion; baseline selection updates 55%/11/20. Updates missing token disables actions; bad token displays Operator authorization required; fixture-token saves automatic on, video max=3, source interval=12/priority=11; selected-source, due-sources and all-enabled enqueue succeed and completed mock jobs appear in history. No console/errors output. All 4 pages scrollWidth==viewport at 390px AND 320px; expanded receipts/evaluation/updates checked at 390px. Screenshots qa-{corpus,costs,evaluation,updates}-mobile.png in scratch. No app failures found. One test wait timed out because I expected 'Showing 51', actual UI correctly says 'Page 2'; later verified exact page labels. No code edits.

The right-hand homepage statistics use real API responses with explicit current-collection, saved-evaluation and all-time-ledger scopes. Unknown charges remain visible. Refresh state is read again when returning to Ask; no mock freshness distribution or forecast query price is displayed.

Final local check: `npm run check` passed typechecking and **149/149 offline tests**, including five new export regressions. `npm run build:web` succeeded. This redesign does not rerun or revise the saved 20-question evaluation.

## Iteration 2 — General closure and Layout QA

Raw reviewer output:

> General closure: focus fix correct after mount, SSE error status correct, rail scopes/fallbacks clear; no logic blockers. Static Layout QA found one small concrete accessibility layering bug: .skip-link z-index:20 equals later sticky .site-header z-index:20, so focused skip link paints underneath header. Set .skip-link z-index:30 (or header lower) to retain visible Skip to content. Rest responsive grids/min-width/overflow/menu geometry clean.

Fix: the skip link now uses z-index 30 above header 20. Browser focus verification returned top=8 and `elementFromPoint` resolved the skip link, confirming it is visible. All confirmed findings are fixed. Download evidence was also exercised: the downloaded JSON parsed successfully and retained the original question and three source passages.

Final independent conclusion:

> **General + Layout QA: 100/100 within the reviewed scope. No remaining P0–P2 findings.**
>
> Closed findings:
> - New-question focus now occurs after the Ask route mounts.
> - SSE failure retains “Request failed” after stream completion.
> - Desktop menu specificity correctly hides the mobile toggle.
> - Mobile menu remains reachable during deep scrolling through fixed, scrollable viewport positioning.
> - Skip link now uses `z-index: 30`; independently verified focused link at `top: 8px` paints above the header.
>
> Reviewed the complete stylesheet, final `web/app.ts`, answer/export modules and collection statistics rail. Responsive grid collapse, long-content wrapping, source anchors, reduced-motion rules, safe exports and separate corpus/evaluation/cost scopes show no blocking issues.
>
> Read-only review; independent browser session closed. Test result of 149 passing checks is coordinator-provided; not rerun during this final review.

## Hosted verification

Deployed runtime: `27a13ad5e01f568dd1c97e8351a18900373c3f9b`. Deployment used a Git archive of the committed tree; server assets matched local SHA-256 hashes. Existing server credentials and persistent data were retained. Both earlier demos remained up.

The Docker image passed **149/149 tests on Linux**, and GitHub Actions run `34774059121` succeeded. All configured model IDs returned HTTP 200 from their provider model endpoints before the paid smoke request. Initial health requests retried connection resets during startup; final HTTPS health reported the exact runtime commit and `corpus-664b2e73d71f`. The container subsequently reported healthy.

A real Ukrainian question about Everstake's founding year completed successfully: run `e936b1ed-33f8-4607-884b-211b58558ef7`, 2018 answer, one cited page, two dated claims, 8 model calls, 33,761 input / 895 output tokens, **$0.02232707 known usage cost**, no unknown calls, 28,589ms backend elapsed / 28.7s browser time. Real SSE research events and exact citation focus were verified. This is one smoke test, not a new evaluation run or a guarantee about all answers.

Hosted Corpus displayed 941 documents with 50 on the first page. Evaluation retained the saved 19/20 and zero assessed invented-fact cases for its older frozen corpus. Costs displayed recorded totals and seven unconfirmed charges. Updates showed automatic execution off and no queued/running jobs; live update settings were not changed during UI QA. All five hosted routes were checked, with no mobile horizontal overflow or browser runtime errors.

Actual hosted screenshots and downloaded evidence are in [artifacts/demo/redesign](../../artifacts/demo/redesign/). Fixture-only screenshots remain in session scratch and are not presented as hosted evidence. Worker branches were integrated into dev and their temporary worktrees removed; the main checkout was not altered.
