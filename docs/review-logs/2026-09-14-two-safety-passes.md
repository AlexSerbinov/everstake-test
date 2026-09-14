# Two documentation and preservation passes — 2026-09-14

Starting private preview: `f50bb09`. The owner requested two further clarity passes with an explicit stop before unnecessary changes or data loss. The editing copy and original-repository review worktree retain their changes uncommitted; only the private preview receives commits.

## Stop conditions

Every populated project folder has an entry README; the guide states its job and points to real files where useful. Current behavior and historical snapshots are distinguished. No file from the baseline is removed, and data, transcripts, figures, prompts, configuration and application code remain byte-identical. Appropriate checks must pass before publication. These are concrete completion criteria, not a claim that every reader will understand every line immediately.

## Pass 1 — Explain the remaining folders

Expanded 39 existing folder READMEs with concrete entrypoints, file links and responsibility boundaries. Corrected the Evaluation guide: the public selector filters baseline runs even though the underlying saved records remain available. Explained evaluation inputs versus saved outputs versus research/grading records; manifests versus full corpus text; overlapping cost snapshots; and the author-only time extractor's file writes.

No application behavior was changed to match documentation. The guides were checked against the implementation. A SHA-256 inventory of all 572 baseline files found no missing files; every changed existing file was a README and every other baseline file remained byte-identical. The existing diagram PNGs were retained, not redrawn for cosmetic churn.

Local repository check: 771 Markdown file links passed. A separate scan of docs/artifacts README links included historical directories normally excluded from the main checker and found no broken local targets. A missing script link introduced during drafting was corrected before publication.

Pass 1 full verification: 226/226 tests, typecheck, repository checks and web build passed. No provider calls or new answer-quality evaluation were performed.

## Pass 2 — Independent cross-check and stop

The runtime-guide author independently reviewed the data/history guides; the data-guide author reviewed the runtime/assistant guides. They verified actual code, saved records and links rather than simply agreeing with the prose. One review checked all 132 links in 19 changed data/history READMEs, including the normally excluded historical directories, and independently proved the 572-file baseline had no losses and only README edits.

Confirmed findings were corrected in documentation:

- The historical paired-run evaluation publisher writes assessed results to SQLite and artifact JSON, requires comparable agent/baseline runs, and overwrites root `EVAL.md`. It is unnecessary for viewing saved results.
- Interim grades refer to `agent-b0993aac` / `baseline-5c467370`; final grades refer to `agent-9a157413` / `baseline-c656c369`. They are different answers, not two judgments of the same run.
- The MCP guide distinguishes the agent headline from the separate MCP result in the linked comparison.

Added a small Ukrainian glossary to the existing code walkthrough. Extended the repository check to require a nonempty README in populated project folders. This caught two real missing guides in `public/findings/` and `public/findings/en/`; both now explain the served bilingual content and link its four unchanged documents. The checker verifies guide presence, not prose quality. All 68 folder guides and 793 local Markdown file links pass.

No new architectural split or runtime rewrite was justified by this pass. Existing diagrams are still accurate for the unchanged implementation; their bytes remain identical. Completion requires the final preservation comparison and publication checks below.

## Final verification and stop

- All 572 baseline files remain present. All 503 protected non-README files (excluding the intentionally edited walkthrough and repository-check script) are byte-identical, including application code, model inputs, configuration, measured artifacts and 55 PNGs. No database or data migration was performed.
- 42 existing READMEs were clarified across both passes; two missing Findings guides were added. The existing Ukrainian walkthrough gained a glossary, and the offline repository checker gained folder-guide coverage. No new runtime module was justified.
- 226/226 tests, typecheck, 68 folder guides, 793 local Markdown links and the web build passed in the publication copy. A temporary fixture independently verified that a populated folder without a README fails the checker and adding its guide makes it pass; the fixture was removed.
- The minified browser bundle remains byte-identical to the preceding verified implementation. Docker execution was not repeated for these documentation/checker changes; the unchanged runtime had already passed the isolated Node 22 container checks in the preceding cycle.
- No paid provider calls, new crawling or new answer-quality evaluation. Reported model metrics remain historical. Existing figures were preserved because the depicted application behavior did not change.

Both requested passes are complete. Remaining work is publication verification and synchronization of the same files into the owner's uncommitted review worktree. GitHub Actions records the outcome for each preview commit. Further cosmetic rewrites would add churn without resolving a concrete issue identified by these passes.
