# Evaluation: read saved answers and their assessments

Start with [evaluation-page.ts](evaluation-page.ts): it fetches `/api/evaluations`, selects a saved view, and renders metrics and question rows. Opening this page does not run evaluation or call a model.

| File | What it explains |
| --- | --- |
| [current-evaluation.ts](current-evaluation.ts) | Select published runs and build a labelled view combining a full run with eligible saved rechecks. Original saved runs are not rewritten. |
| [default-evaluation-run.ts](default-evaluation-run.ts) | Prefer the newest fully assessed 20-question agent run, then fall back to another full assessment or newest run. Selection never uses the highest score. |
| [evaluation-metrics.ts](evaluation-metrics.ts) | Keep planned, completed, assessed, and failed-provider counts separate. |
| [evaluation-table.ts](evaluation-table.ts) | Render question rows, quality labels, and failure details. |
| [question-result-card.ts](question-result-card.ts) | Define shared result-row types and an alternate saved-answer card renderer; the current page uses the table renderer. |
| [average-quality.ts](average-quality.ts) | Calculate the displayed quality average without inventing missing assessments. |
| [mcp-comparison.ts](mcp-comparison.ts) | Find a completed MCP comparison with the same questions and render its summary. |
| [method-comparison.ts](method-comparison.ts), [evaluation-groups.ts](evaluation-groups.ts) | Tested helpers for method comparisons and question groups, retained alongside the current page. |

Published run IDs live in [evaluation-submission.json](../../../assistant/config/evaluation-submission.json). `publicEvaluations()` excludes baseline runs from the current page's selector; their saved JSON remains available in [artifacts/evaluation](../../../artifacts/evaluation/README.md). The combined recheck view names its underlying runs and includes their costs; it is not a new measured run.

Neighboring tests cover selection, matching question sets, recheck eligibility, missing assessments, and display filters. Filtering rows must not change the full-run accuracy denominator. The published explanation and failure breakdown are in [EVAL.md](../../../EVAL.md).
