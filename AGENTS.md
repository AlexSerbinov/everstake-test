# Project guide for agents and contributors

## What this repository is

A take-home test assignment for the **AI Automation & Agentic Systems Lead** role at Everstake, done by Oleksandr Serbinov. The task: build a knowledge assistant that answers questions about Everstake from a corpus of public sources the system crawls itself, with an as-of date and cited sources on every answer, an honest "no reliable answer" when the corpus lacks the fact, a measured evaluation, measured costs, and a written report; plus a one-page process redesign (Part B).

Two independent implementations of the same brief live side by side and are both deployed:

| Folder | Stack | Live | Role |
|---|---|---|---|
| `claude-work/` | TypeScript, Node ≥ 22.13, SQLite (`node:sqlite`), Hono, plain HTML/CSS/JS UI | https://everstake.89-167-19-222.sslip.io | primary submission |
| `codex-work/` | Python, SQLite, tool-loop agent | https://everstake-codex.89-167-19-222.sslip.io | second, independent run for comparison |

`README.md` at the root maps every deliverable of the assignment to the files that satisfy it.

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

## Layout

```
docs/                      assignment, translation, seed CSV, plan, research notes, task briefs, daily reports
claude-work/               primary implementation (see its README, REPORT, EVAL, ADVERSARIAL, COST, PROCESS)
codex-work/                second implementation (see its README, REPORT, EVAL, SUMMARY)
CHANGELOG.md               narrative timeline of the work
docs/reports/YYYY-MM-DD.md daily progress reports
docs/research/             design notes: freshness, scale & trust, adversarial evaluation, internal knowledge, reporting
docs/github-map/           documentation of Everstake's public GitHub repositories, used as corpus input
docs/DEFENCE.md            short theses for the defence session
```

Folders `reference/`, `everstake-mcp/`, `raw/`, `mcp-test/` are local scratch (third-party code, raw HTML, probes) and are git-ignored.

## Working rules

- **Read before changing.** Each implementation has its own `README.md`, `REPORT.md` and config; the reports state measured numbers and must be updated when the numbers change.
- **Stay in your lane.** Work on `claude-work/` or `codex-work/` touches only that folder (plus `docs/` and the root docs). The two implementations must not read from or depend on each other.
- **Measured, not estimated.** Token counts come from provider usage fields; costs are tokens × a price table with the date the prices were copied; timings, CPU and memory come from the process. Anything assumed is labelled as assumed.
- **Models.** Gemini 3.x generation only (`gemini-3.8-flash` for answers, `gemini-3.5-flash-lite` for cheap extraction and judging); OpenAI only for embeddings; an Anthropic path exists in `claude-work` and is used when a key is available. Never use Gemini 2.5.
- **Explainable code.** No RAG frameworks; prefer small, readable modules; rules for models live in `prompts/` and `config/` files, not in string literals; agents, skills and prompts are real files.
- **Safety invariants** (do not weaken): instruction sentences addressed to AI are stripped at index time; context is passed as tagged data; citations are validated in code; every number in an answer must be grounded in tool-returned text; provider errors are never reported as abstentions.
- **Git.** Commit with real timestamps and descriptive messages. Do not push, force-push, rebase or rewrite history unless the owner explicitly asks. Do not commit secrets: `.env` files are ignored; `.env.example` lists the variables.
- **Tests must stay green** (`npm test` in `claude-work`, the Python test suite in `codex-work`) before a commit.
- **Deployment.** Each implementation has its own deploy script targeting its own port and data directory on the demo host; never stop, modify or remove services you did not create.

## Defence notes: `docs/DEFENCE.md`

Everything that will be shown or explained at the defence session is collected in `docs/DEFENCE.md`, written in **Ukrainian**, as **short plain-language theses**, one block per part of the system: how it works, what to show on screen, and a one-sentence takeaway. Keep it that way — it is a speaker's script, not documentation.

Add to it whenever work produces something worth showing: a design decision with a clear reason, a mechanism that is verified at the system level rather than assumed (a gate in code, a measured number, a test that proves a property), a surprising finding in the corpus, or a trade-off that was made deliberately. If a behaviour is non-obvious — two sources disagree and the system picks one, a number is blocked, a source is down-weighted — write down *why*, in words a non-engineer follows, and which screen demonstrates it. Prefer honesty over polish: limitations belong there too, with the answer to "what would you do next".

## Where to look for specific answers

| Question | File |
|---|---|
| Which requirement is satisfied where | `README.md` (root), `docs/CHECKLIST.md` |
| Architecture and decisions, with reasons | `claude-work/REPORT.md`, `codex-work/REPORT.md` |
| Evaluation results and failures | `claude-work/EVAL.md`, `claude-work/ADVERSARIAL.md`, `codex-work/EVAL.md` |
| Measured costs | `claude-work/COST.md`, `codex-work/COST.md` |
| How the corpus was chosen (robots, sitemaps, redirects) | `docs/crawl-survey.md`, `claude-work/config/sources.yaml` |
| Original plan | `docs/PLAN.md` |
| Defence theses | `docs/DEFENCE.md`, `docs/defence-answers.md` |
