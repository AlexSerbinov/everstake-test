# Repository reorganization verification — 2026-09-14

Base: `85818044bb09f9e5e1baab5f1e2d60ff8a155054` on `dev`. Changes are uncommitted in an independent local clone. No original checkout, live database, or deployed application was modified.

## Scope and acceptance

Assignment §§3–6 and 8–10 remain the acceptance criteria: actual researcher files, corpus-only evidence, citation/date/number checks, explicit abstention versus provider errors, measured costs, preserved historical evaluation, runnable application, explainable code, and real development history. Both PROCESS languages and time records were preserved byte-for-byte. README content was retained except relocated links.

The implementation changes concern configuration validation and model compatibility, extraction of answer and refresh responsibilities, comments, SQL formatting without schema changes, browser helper extraction, and packaging paths. No company-specific answer rules were introduced.

## Automated checks

- Baseline: typecheck and all **203** existing offline tests passed before edits.
- Integrated version: typecheck and **218/218** tests passed, including new evidence-retention, calculation, configuration, and embedding-compatibility regressions.
- `npm run check:repository` validates required deliverables, real researcher inputs, configuration, Compose context/identity/mounts, and current local Markdown file links. Archived plans, external URLs, and heading anchors are explicitly excluded.
- `npm run build:web` succeeds. `bash -n scripts/deploy.sh` and `git diff --check` pass.
- `docker compose -f deploy/compose.yaml config --no-env-resolution --format json` resolves build context, root environment-file path, and persistent mounts correctly without reading secrets.
- Docker image builds on Node 22. Its checks run in an isolated container with network disabled, two CPUs, and a 2 GiB memory limit. An initial image lacked fixtures needed by the existing submission test (217/218); packaging was corrected to include reviewer documents and frozen artifacts while excluding secrets, mutable data, dependencies, and caches. The corrected image passes all **218** tests and the repository checker.

## Independent review

Applied the review-loop skill with one read-only GPT-5.6 Sol General reviewer. The quota check reported 70% weekly use and a `minimal` tier cap; the weekly pacing gate limited the review to one reviewer. Detailed tool logs are session-local, not application measurements.

Reviewer result: **no actionable introduced regressions; no Critical/High/Medium/Low findings**. The reviewer checked moved and untracked files, action/evidence extraction, model validation, refresh fencing and transaction semantics, deployment paths, manifest hashing, and the cost UI extraction. It independently reran the typecheck, 218 tests, repository checker, and diff whitespace check.

A final narrow follow-up also found no regressions in Docker fixture packaging, explicit Compose project identity, the untracked-file deployment guard, or validated researcher bounds/defaults. A direct manifest check confirmed that changing an untracked helper changes `dirtyDiffHash`, and restoring its bytes restores the hash.

A dedicated Opus Layout QA agent was not available through the tools in this session. The frontend worker compared the extracted DOM statements with the baseline AST; the coordinator additionally inspected desktop/mobile screenshots. No CSS or page-template redesign was part of this task.

## Browser and runtime smoke

Used `agent-browser` against an isolated local server and scratch SQLite database. Imported saved evaluation runs and a supported saved MCP ledger for display only; no new provider calls were made.

Checked Ask, Evaluation, Costs, Corpus, Updates, and an individual Findings document. Evaluation displays the selected 16/20 summary with its recheck caveat. Costs renders both an empty ledger and saved provider activity. Desktop 1440×1000 and mobile 390×844 checks showed no horizontal document overflow in inspected states, and the browser reported no JavaScript errors. Browser sessions were closed after verification.

The demo server had no corpus or provider credentials; paid answer generation, crawling, transcription, and live deployment were not exercised. Answer generation and streaming behavior remain covered by offline provider fixtures. Saved evaluation scores are historical measurements, not a new post-refactor benchmark.

The final Node 22 image was also started in a disposable container with networking disabled and no mounted live data. `/`, `/app.js`, `/api/costs`, `/api/corpus`, `/api/updates`, and `/api/evaluations` returned HTTP 200; the evaluations endpoint returned imported saved runs. This verifies image startup independently of the host's Node installation. The temporary container and local smoke server were stopped after checking.
