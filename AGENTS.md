# Everstake take-home assignment — project instructions

This is the single project guide for agents and contributors. We are building Oleksandr Serbinov's take-home assignment for the AI Automation & Agentic Systems Lead role at Everstake: a source-grounded knowledge assistant and a one-page process redesign (Part B).

## Start here

Read the relevant assignment sections, `docs/REBUILD.md`, and the assigned execution package before changing code. Build one small, readable TypeScript application with SQLite and clear feature modules. No RAG frameworks or unnecessary service infrastructure. The current `claude-work/` and `codex-work/` folders are reference prototypes; their results are not measurements of the new implementation.

## Source of truth: the assignment

**Every piece of work in this repository must be checked against the assignment text.** It is the acceptance criteria, not a suggestion.

- `docs/TEST_ASSIGNMENT_EN.md` — the assignment, verbatim (converted from the original `.docx` in the same folder).
- `docs/TEST_ASSIGNMENT_UA.md` — a word-for-word Ukrainian translation for reading.
- `docs/corpus_sources.csv` — the seed list of ~60 URLs supplied with the assignment.

Before starting or finishing a task, re-read the relevant numbered section (Part A §3–§6, Part B §7, deliverables §8, defence §9, AI-use §10, grading §11) and confirm the result still satisfies it. When a requirement and an implementation idea conflict, the requirement wins; when a requirement is ambiguous, write the interpretation down in `REPORT.md` of the affected implementation.

Key non-negotiables from the assignment, paraphrased:
- answers come from the crawled corpus only, never from the model's own knowledge; the system must say "no reliable answer" when the corpus lacks the fact;
- every factual answer carries the value, the as-of date, and a link to the specific source; synthesis answers use several sources and show change over time;
- crawling respects `robots.txt`; inclusions and exclusions are justified; the corpus has ≥ 200 documents;
- recency and source authority decide, not similarity rank or majority count; duplicates are found, counted and explained;
- instructions addressed to AI inside documents are handled architecturally, not by prompt wording;
- 20-question evaluation with ≥ 5 negative cases, reporting accuracy, successes, failures and, separately, invented facts;
- costs are measured, not estimated, with a ×50 extrapolation and its arithmetic;
- one paragraph comparing against Everstake's own MCP server, honest in both directions;
- reviewers must be able to run the system or see it running; every line must be explainable and modifiable live.

## Effort budget and accounting

- Aim to finish Part A within eight hours of human active effort; the assignment gives a 6–8 hour expectation and budgets Part B at approximately one hour separately. Reduce scope deliberately when necessary and document the trade-off.
- Our accounting convention counts the user's active time: briefing, planning, reading, thinking, review, testing, supervision and integration. Autonomous agent runs while the user is away do not add to human hours. This distinction is our disclosed method, not an explicit exclusion stated by the assignment.
- Record autonomous agent elapsed time and API spending separately. Parallel agents do not multiply human hours. Subscription usage is not necessarily zero resource usage.
- Keep durations and their evidence in `docs/TIME.md`, not in this guide. Record actual session boundaries when tracking is authorized, pause when the user leaves, and merge overlapping human intervals. Do not infer absence from silence in prompt logs.
- Keep retrospective user estimates separate from the historical event-based count; do not add both totals together. Label uncertainty. Eight hours is a budget, not a required reported result.
- Git timestamps are real recording times, not timesheets. Do not backdate history or fabricate durations. TIME describes effort; CHANGELOG/TIMELINE describes outcomes; COST describes spending.

## Git and parallel work

Continue the new implementation on `dev` in its registered worktree. Keep the original checkout and its uncommitted prototype changes intact. Use `git worktree list` to find it and check reference freshness before reading the old implementations. Archiving is deferred, not a prerequisite.

Start worker branches only from a verified committed foundation, using `git worktree add` outside the repository. Each package needs dependencies, owned paths, acceptance checks and a handoff. The coordinator owns contracts, database schema, package/lock files and application entry points. Give workers separate mutable databases, output directories and ports; only frozen corpus snapshots may be shared read-only. Integrate and verify completed packages sequentially.

Commit and push only with owner authorization, using descriptive messages and real timestamps. Do not force-push, rewrite history, discard working changes or merge into main without explicit authorization. The final main tree should contain the verified single implementation and preserve the development history. Do not delete prototype folders until required behavior is covered and the cleanup is authorized.

## Implementation and validation

- Prefer small readable modules, general evidence rules and configuration over question-specific hardcoding. Keep actual model instructions in `prompts/` and configuration in `config/`.
- Use Gemini 3.x generation: `gemini-3.8-flash` for answers and speaker attribution/review, `gemini-3.5-flash-lite` for cheap extraction/judging; OpenAI only for embeddings. Do not use Gemini 2.5. Keep provider identifiers configurable and validate availability before paid runs.
- Strip AI-directed instruction sentences at index time, pass context as tagged data, validate citations in code and ground answer numbers in tool-returned text. Provider errors are not evidence-based abstentions. Do not weaken these invariants.
- Get token counts from provider usage. Use a dated price table; distinguish calculated usage costs, provider billing, unknown costs and explicit forecasts. Do not reuse prototype totals as new measurements.
- Run checks appropriate to the changed behavior before committing; keep the affected implementation's tests green. Report failures and unrun checks honestly.
- Never commit secrets, mutable databases, build output or caches. Preserve existing `.env.example` keys.
- The two existing demo services have separate ports and data directories. Do not stop or alter them during the rebuild. The planned new target is documented in `docs/REBUILD.md`.

## Documentation

Keep reviewer entry points concise: README for setup and deliverables, REPORT for decisions and limitations, EVAL for measured results, COST for spending, PROCESS for Part B. Prototype reports remain historical evidence until replaced by new measurements.

Keep `docs/DEFENCE.md` as short Ukrainian speaker notes: how each block works, what to show, why a decision was made, and known limitations. User communication is Ukrainian; code, comments, errors and commit messages are English.
