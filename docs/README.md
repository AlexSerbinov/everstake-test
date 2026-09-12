# `docs/` — index

Background material for the Everstake test assignment: the inputs as they arrived, the research done before any code was written, and the briefs used to task the two implementations. Nothing here is application code — the code lives in [`../claude-work/`](../claude-work) and [`../codex-work/`](../codex-work); start at the [root README](../README.md).

**Language:** the assignment inputs and the two Codex briefs are English; the planning, research and reporting notes were written in Ukrainian for speed and are marked **UA** below. The one file an English-reading reviewer needs is [`TEST_ASSIGNMENT_EN.md`](TEST_ASSIGNMENT_EN.md).

## Assignment inputs

| File | What it is | Why it exists / when |
|---|---|---|
| [`TEST ASSIGNMENT AI Automation & Agentic Systems Lead.docx`](TEST%20ASSIGNMENT%20AI%20Automation%20&%20Agentic%20Systems%20Lead.docx) | The original assignment file, untouched. **EN** | Received from Everstake HR on 2026-09-11 at 17:04. |
| [`TEST_ASSIGNMENT_EN.md`](TEST_ASSIGNMENT_EN.md) | Markdown conversion of the `.docx` — the version every brief and checklist refers to. **EN** | Converted 2026-09-11 so the requirements could be quoted and linked. |
| [`TEST_ASSIGNMENT_UA.md`](TEST_ASSIGNMENT_UA.md) | Word-for-word Ukrainian translation. **UA** | Written 2026-09-11 for a careful first read; no interpretation added. |
| [`corpus_sources.csv`](corpus_sources.csv) | The seed URL list supplied with the assignment: 59 data rows (60 lines with the header), each with category, tier, language and a note. **EN** | The starting point for the crawl; both implementations read it directly. |

## Research and decisions

| File | What it is | Why it exists / when |
|---|---|---|
| [`crawl-survey.md`](crawl-survey.md) | Crawlability survey of all 60 seed URLs: `robots.txt` for 28 hosts, 11 sitemaps, redirect chains, `llms.txt`, per-host noise ratios, YouTube. **UA** | 2026-09-11 20:00, before the crawler existed. Established that ~810 documents are reachable without JS, that `everstake.one` is a 301 to `.com`, and that reaching 200 documents was never the hard part. |
| [`localtrade-assessment.md`](localtrade-assessment.md) | Assessment of an existing in-house TypeScript project as a scaffold for this system. **UA** | 2026-09-11 20:06. Conclusion: rejected — only the deployment scheme (Docker + Caddy + sslip.io) was reused. |
| [`PLAN.md`](PLAN.md) | The build plan: pipeline stages, ranking design, gates, eval design, cost model, deployment. **UA** | 2026-09-11 20:15. Written before any code; `claude-work/` was built from it. |
| [`design-brief.md`](design-brief.md) | Brief for a UI pass — audience, what must be visible on a shared screen, current state of each tab. **UA** | 2026-09-11 21:03, after the first deploy. |
| [`agentic-spec.md`](agentic-spec.md) | Shared contract for the agent layer: tool list, SSE event shapes, endpoint behaviour — written so a backend and a frontend workstream could meet in the middle. **EN** | 2026-09-12 03:03, when `claude-work` moved from "one retrieval → one prompt" to a tool loop. |
| [`research/01-freshness.md`](research/01-freshness.md) | How the corpus stays current: indexed snapshots vs on-demand live fetch vs MCP for live numbers, and why the answer is a hybrid. **UA** | 2026-09-12 03:09. |
| [`research/02-scale-and-trust.md`](research/02-scale-and-trust.md) | Scale to 6 000–10 000 call recordings and tamper-proof numbers: STT cost, hashes, WORM, signed audit log, the four prompt-injection entry points. **UA** | 2026-09-12 03:12. Source of the gate-3 number-grounding idea. |
| [`research/03-adversarial-eval.md`](research/03-adversarial-eval.md) | Design of the 20-case adversarial set and why a model must not judge an attack on itself. **UA** | 2026-09-12 03:14. Implemented as `claude-work/eval/adversarial.yaml`. |
| [`research/04-internal-knowledge-for-ivanna.md`](research/04-internal-knowledge-for-ivanna.md) | Internal knowledge system for an operations director: connectors with ACLs, weekly reports, what deliberately stays human. **UA** | 2026-09-12 03:17. This is the raw material for Part B — `PROCESS.md` itself is still unwritten. |
| [`research/05-progress-reporting.md`](research/05-progress-reporting.md) | How this project reports on itself: the agent reconstructs the day from git log and eval results, the human signs it. **UA** | 2026-09-12 03:18. A test of the claim in note 04, applied to this repository. |

## Process and tasking

| File | What it is | Why it exists / when |
|---|---|---|
| [`CHECKLIST.md`](CHECKLIST.md) | Self-check of `claude-work` against every numbered requirement, plus a priority list of what to do before submitting. **UA** | 2026-09-11 21:09. ⚠️ Written before the last two runs: its eval figures (strict 65%) are stale against `claude-work/EVAL.md`, and its paths say `everstake-kb/`, the directory that is now `claude-work/`. |
| [`codex-task.md`](codex-task.md) | The brief handed to Codex (GPT-5.6) for the first independent run: inputs, deployment target, rules, and the instruction not to look at `claude-work/`. **EN** | 2026-09-11 21:59. |
| [`codex-task-2.md`](codex-task-2.md) | The second brief: tool-using agent, visible pipeline, freshness strategy, tamper-proof provenance, a 6 000–10 000-call scale sketch, and a design pass. **EN** | 2026-09-12 03:05. |
| [`codex-last-message-2.md`](codex-last-message-2.md) | Codex's final hand-off message from run 2 — what it deployed and what it spent. **UA** | 2026-09-12 03:41. |
| [`codex-run-2.log`](codex-run-2.log) | Raw transcript of Codex run 2 (~12 MB), kept as unedited working history. | 2026-09-12 03:41. The run-1 log is on disk but gitignored. |
| [`telegram-ideas-2026-09-11.md`](telegram-ideas-2026-09-11.md) | Transcribed voice notes from the working night — thinking-out-loud that fed the research notes above. **UA** | 2026-09-12 03:04. |
| [`reports/2026-09-11.md`](reports/2026-09-11.md) | Daily report: what was built, the decisions of the day and why, spend. **UA** | 2026-09-12 03:19. |
| [`reports/2026-09-12.md`](reports/2026-09-12.md) | Daily report for the second session: agent layer, visible pipeline, gate 3, adversarial suite, research notes. **UA** | 2026-09-12 03:56. |
