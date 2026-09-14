# Evaluation: collect answers before judging them

Start with [run-evaluation.ts](run-evaluation.ts). It reads the question set from [eval](../../../eval/README.md), calls the supplied answer runner in agent or baseline mode, and saves progress after every answer to SQLite and [artifacts/evaluation](../../../artifacts/evaluation/README.md).

| Function | Responsibility |
| --- | --- |
| `readQuestions()` | Load the core questions or the separate scenario set. |
| `runEvaluation()` | Validate the selected questions, record the code/corpus versions, run questions sequentially, and stop an exhausted-budget run as incomplete. |
| `saveEvaluation()` | Recompute the summary and persist the current run in the database and JSON file. |
| `summarize()` | Count completed and assessed answers separately; report accuracy only when the planned set is fully assessed. |

A returned answer is initially `pending`, with invented facts unknown. A successful API call is not a passing answer. [publish-evaluation.ts](../../../scripts/publish-evaluation.ts) is the historical publisher for a paired agent/baseline comparison on the same corpus. It imports independently reviewed grades, writes assessed runs to SQLite and artifact JSON, and **overwrites root `EVAL.md`**; it does not create the judgments itself. It is not needed to inspect saved results or the current combined recheck view. Published outcomes live in [EVAL.md](../../../EVAL.md). Starting a real evaluation may incur provider charges; opening the browser's saved results does not rerun it.

`run-evaluation.test.ts` checks runner behavior; `evaluation.test.ts` checks question-set and summary rules; `mcp-benchmark.test.ts` checks the separate MCP comparison. These tests use fixtures and controlled responses rather than measuring current model quality.
