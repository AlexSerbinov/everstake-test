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
