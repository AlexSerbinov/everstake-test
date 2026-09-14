# Saved evaluation runs

Each run records questions, generated answers, outcomes, and available usage measurements. Agent, baseline, and MCP comparison outputs remain separate so their results can be traced.

Use [EVAL.md](../../EVAL.md) to find the reported runs and understand the scoring. A completed request is not automatically a correct answer.

## Why there are several evaluation folders

| Location | Its job |
| --- | --- |
| [eval/](../../eval/README.md) | Inputs: fixed questions, references and review criteria. |
| This folder | Outputs: actual saved answers and run metadata. Filenames include run IDs. |
| [docs/evaluation/](../../docs/evaluation/README.md) | Explanations of diagnostic work and question-set changes. |
| [docs/evaluation-grades/](../../docs/evaluation-grades/README.md) | Separate saved review records for earlier evaluations. |
| [EVAL.md](../../EVAL.md) | The reported results, failure analysis and links to the runs being counted. |

For a concrete comparison, open the [saved MCP core-v2 answers](mcp-core-v2.json). In agent exports, inspect `questionSetVersion`, `corpusVersion`, `plannedTotal` and `rows` when present. Earlier files have fewer metadata fields. Do not combine runs just because they share an `agent-` prefix: they can cover different questions, corpus snapshots or partial rechecks.
