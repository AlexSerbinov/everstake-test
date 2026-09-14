# Three further readability cycles — 2026-09-14

Requested scope: make repository navigation, YouTube Markdown, code flow and diagrams easier to understand; retain the assignment deliverables and verify each cycle. Starting private preview: `301d4df`. The original checkout remains untouched; the combined change stays uncommitted in the separate review worktree. Only the private preview receives commits.

## Cycle 1 — Find the material and follow an update

The 18 reviewed and 12 original YouTube Markdown transcripts were already present and byte-identical to the original checkout. Restored direct browsing, not invented or regenerated transcripts. Folder guides now link specific files and explain which folders contain runtime code, saved results and historical notes. Added an OpenCV/Pillow repository reading map and inspected its rendered PNG.

The update worker's main function now shows scheduling, lease acquisition, one job and cleanup. Shared eligibility checks remove duplicated conditions; video billing has a named helper in the same file. Added a regression for losing the worker lease. No new runtime folder or public API was introduced.

Review budget: 78% weekly usage, minimal tier, one General reviewer at low effort. Existing plans and review logs are deliberately retained as development evidence, not runtime dependencies.

### General reviewer — raw conclusion

Cycle 1 General review: no Critical/High/Medium findings. Score 98%. Inspected complete diff vs 301d4df (13 tracked files + untracked render-reading-guides.py, review log, PNG), .github/AGENTS.md, assignment §§4–5 and §§8–10, full controller.ts/refresh-videos.ts before+after, application/API/tests callers, all changed Markdown links and YouTube counts/statuses. Helper extraction is behavior-preserving; billing helper passes identical run/session budgets and unknown actual cost semantics. Lease test correctly proves foreign lease preservation on progress-time ownership loss. Verified: typecheck passes; 15 update tests pass; check:repository validates 510 local Markdown links; git diff --check clean; 18 reviewed exports and 12 raw transcripts match docs. Residual low-risk limitation: new lease regression covers loss detected during progress callback, not ownership loss after the last callback; that completion-boundary gap is pre-existing and outside this diff, so I did not classify it.

### Coordinator validation

`npm run check`: 223/223 tests passed, typecheck passed, 510 local file links verified. `npm run build:web` passed. No paid calls or new model-quality evaluation. No actionable review findings to fix in this cycle. The shared lease/eligibility helpers were preferred over a new worker module because the queue stays understandable in one file and the public interface remains unchanged.

## Cycle 2 — Group by page and explain the data flow

A fresh navigation pass found 15 browser feature folders for six visible pages. Consolidated the Ask components into `web/features/ask/`, moved the collection summary into `corpus/`, and retained `costs/`, `evaluation/`, `findings/`, and `updates/`. One linked Ask guide replaces nine small component guides. Import paths changed; markup, CSS and behavior did not. The minified browser bundle is byte-identical to the pre-cycle baseline.

The cost dashboard now uses named same-file helpers for parent traversal, ordered grouping, measured averages and provider summaries. Added a legacy-cycle and nearest-question attribution regression. Shared calculations preserve call order and unknown-cost semantics. Added OpenCV/Pillow diagrams for video admission and search; both rendered PNGs were inspected. The script catalogue now distinguishes read-only checks, paid operations, database writes and historical report generators.

### General reviewer — raw conclusion

Score: 98/100.

Scope reviewed: the complete staged/unstaged/untracked working-tree diff against HEAD f4597ff, including all deleted and newly added frontend paths; `.github/AGENTS.md`; assignment §§5.6 and 8–10; `docs/REBUILD.md`; the full `cost-dashboard.ts` before/after logic and regression tests; all frontend relocation imports and callers; updated module/operator documentation; the diagram renderer and both generated PNGs; and the recorded pre/post browser bundles.

Findings: no introduced Critical, High, or Medium defects.

Evidence: `cost-dashboard.ts` preserves the previous deterministic cycle fallback, call ordering, root-purpose attribution, unknown-price exclusion, provider ordering, update-root handling, and query/question semantics. The new nearest-question traversal correctly prevents nested verification calls from being charged to an outer query when an inner question exists; traversal terminates on legacy cycles. The new regression exercises both properties. Frontend source changes are relocations plus relative-import updates; the only content differences in `answer-view.ts` are imports. Both supplied minified bundles have the identical SHA-256 `f21d636e4b36e975b47455c41c29641c7ac6c9c73dfa92c78336f03515853024`, supporting markup, DOM, CSS, and behavior parity. Remaining evaluation imports resolve to the new `ask/` location, and no active-code stale imports were found. The six-folder claim is accurate for the published Git tree (the locally lingering empty deleted directories are untracked filesystem directories and Git will not publish them). Script effect descriptions match implementation, including `freeze-corpus.ts` rebuilding the database text index and writing the frozen manifest. Both 1600×1020 diagrams were inspected at original resolution; text is readable, arrows and grouping are coherent, and claims match the described search and video-admission architecture. New documentation links resolve under the reported 566-link repository check. `git diff --check` is clean. Coordinator-reported verification is consistent with the reviewed change: 224 tests, typecheck, 566 links, and web build passed.

Residual risk (below finding threshold): historical planning documents retain the old feature paths, but they are explicitly dated plans/history rather than current navigation guidance, so this does not make the current repository instructions misleading.

### Coordinator validation

`npm run check`: 224/224 tests, typecheck and 566 local links passed. `npm run build:web` passed. No paid calls or fresh model-quality evaluation. No actionable findings. Page-based grouping was chosen over more nested component folders because the Ask workflow can now be read in one place; the unchanged minified bundle verifies this move did not rewrite frontend behavior.

## Cycle 3 — Read the review steps and verify the final package

A fresh entrypoint check added one navigation line to each root README: folder map, readable YouTube transcripts, code and review records. Existing prose, diagrams and measured headlines stay intact. Review records now have a linked catalogue explaining why they remain in the repository.

The source catalogue uses ordinary commented YAML instead of JSON syntax inside YAML. All 29 source records and the YouTube configuration were compared before/after as parsed data and are exactly unchanged. No source, price, model, prompt or evidence requirement was changed. Sources went from 417 to 358 lines including the final newline. Added and visually inspected a fourth OpenCV/Pillow diagram, showing runs, attempts and receipts.

`verifyClaims` now presents the review sequence in 53 lines instead of 162: review every claim, compare newer evidence and exceptions, format checks, review the whole answer, and check synthesis evidence. Details remain named helpers in the same file. Added two regressions using fake model responses: duplicate assessments retry without changing claim order, and two incomplete reviews remain a provider error. Focused answer tests: 41/41 passed; typecheck passed.

### General reviewer — raw conclusion

Score: 100/100.

Scope reviewed: the complete tracked and untracked working-tree diff against HEAD 124e9c1 in `github-publish`; `.github/AGENTS.md`; assignment §§5.1, 5.3–5.5, and 8–10; full `verify-claims.ts` before/after implementation and all answer tests; `sources.yaml` and `youtube.yaml` before/after parsed representations; root navigation, config/module guides, review-log catalogue, cost-flow renderer, and the untracked 1600×1020 PNG at original resolution.

Findings: no introduced Critical, High, or Medium defects, and no materially misleading claims.

Evidence: `verifyClaims` is exactly 53 physical lines versus 162 before extraction. Its initial request is unchanged (same stage/model/prompt, JSON key order, registry and per-claim evidence payload order, and max tokens); malformed/duplicate assessments still retry the identical request once and fail as a provider error after two invalid responses. Focused currentness and exception calls retain reviewer order, currentness-before-exception order, predicates, models/prompts/retry behavior, and count. Check formatting/reasons/order, whole-answer scope gating/payload, and synthesis group/date validation are unchanged. The two new fake-provider regressions directly protect reordered valid reviews and repeated incomplete reviews. Parsed old/new `sources.yaml` are exactly JSON-equal (29 records, serialized length 12,900), as are old/new `youtube.yaml` (serialized length 1,163); comments do not alter runtime configuration. The source line-count claim is accurate under the stated convention (417→358 when counting the final split line), and README/review-log links resolve. The cost diagram is readable, visually coherent, and accurately distinguishes reservations, measured charges, unknown usage, retries, descendant aggregation, eligible averages, and the 50× forecast.

Independent validation: focused answer suite 41/41 passed; `npm run check` passed with 226/226 tests, typecheck, and 584 local Markdown links; `npm run build:web` passed; `git diff --check` is clean. No paid calls or fresh model-quality evaluation were performed, consistent with the documentation.

### Coordinator validation and final scope

All 226 tests, typecheck and the 584-link repository check also passed in the built Node 22 Docker image, with external networking disabled. An isolated container started the real HTTP server and imported saved evaluations. `/`, `/app.js`, `/health`, `/api/questions`, `/api/costs`, `/api/corpus`, `/api/updates` and `/api/evaluations` returned HTTP 200; the question endpoint contained 20 entries and saved evaluation runs were present. No serving demo, host port, production database or provider key was used.

The final assignment check retained the actual agent, skill and prompt files, seed list, evaluation and cost evidence, bilingual PROCESS/REPORT, TIMELOG and genuine Git history. Readability checks do not establish a new answer-quality score: the saved evaluation still describes its stated historical runs. No material findings remain from these three change reviews. Named same-file review phases were chosen over a generic review framework so each model call and evidence check remains visible and explainable.

Summary: three completed improvement cycles; four new reproducible diagrams; six browser feature folders instead of 15; YouTube Markdown content retained with direct browsing; four added regressions (222 → 226 tests). The private repository contains a commit for each cycle; the original repository's review worktree retains the combined work as uncommitted changes. GitHub Actions records each published commit's final workflow status.
