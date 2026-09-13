# Requirement audit

Audit against the original assignment, 13 September 2026. Implemented mechanisms are distinct from observed answer quality: passing tests is not a claim that every factual answer is correct.

| Assignment | Implementation / deliverable | Verification and remaining limits |
|---|---|---|
| §3.1 factual lookup | `src/services/answer/`, dated citation cards | Final twenty-question evaluation includes factual failures; value, date and citation gates are tested. |
| §3.2 synthesis | Multiple source groups and dated evidence; bounded research tools | Synthesis cases are graded for actual trajectory, not just multiple links. |
| §4 corpus expansion and robots | Configured crawler, sitemap/link discovery, exclusion reports | 935 web + four accepted video documents; 939 exceeds 200. Blocked sources and pending videos remain explicit. |
| §5.1 authority and recency | Provenance, separate publication/check dates, grouped retrieval, counterevidence review | No role-specific answer routing. The evaluation exposes missed contradictory conditions/counts. |
| §5.2 duplicates | Exact hashes plus near-content groups | Six groups, seven extra exact copies and five extra near-group members. Near variants remain indexed. |
| §5.3 abstention | Explicit `no_reliable_answer`, separate infrastructure errors | Five negative cases; omissions and errors remain in the denominator. |
| §5.4 in-document instructions | Ingestion sanitation, metadata allowlist, restricted tools, citation/number checks | Offline adversarial fixtures and audit of actual frozen chunks. Semantic review remains fallible. |
| §5.5 evaluation | `EVAL.md`, twenty reference questions and saved complete runs | Independent agent rubric review; all responses, failures and invented-fact cases retained. No human-certified score claimed. |
| §5.6 measured cost | `COST.md`, provider attempt ledger, Costs screen | Index tokens/cost, per-query costs and ×50 arithmetic. Twelve pre-deployment calls remain unpriced; Soniox forecast is separate. |
| §5.7 MCP comparison | `docs/MCP_COMPARISON.md` | One paragraph tied to inspected official source; no invented head-to-head measurement. |
| §6 runnable system | Node 22 setup, Docker, isolated demo | Local and Linux Node 22 checks; final deployment evidence in `docs/EXECUTION.md`. |
| §7 process redesign | `PROCESS.md` | One-page prose: as-is/to-be, three metrics, proactive failure detection and non-agent responsibilities. |
| §8 deliverables | README, REPORT, EVAL, COST, PROCESS, actual agent/skill/prompt files | One implementation in the active tree. Full planning detail retained under `docs/plan/`. |
| §8 working history | Real Git timestamps and feature integration commits | Original prototype history retained. Human estimates are not inferred from commit intervals. |
| §9 live modification and defence | `docs/DEFENCE.md`, source config, service modules and fixture tests | Candidate must still demonstrate personal understanding during the call; automation cannot certify that. |
| §10 explainability | Small TypeScript modules, plain naming, explicit boundaries | Review the code path with the candidate; an AI-built artifact does not itself establish explainability. |

Deliberate scope reductions and next-month priorities are in REPORT. The submission measures limitations rather than declaring all behavioral requirements perfectly solved.
