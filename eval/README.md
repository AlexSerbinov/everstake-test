# Questions the system is evaluated against

Open [questions.json](questions.json) for the current twenty-question set, including reference answers and negative cases. References are for grading; the answering system must find evidence in the corpus instead of receiving these reference answers as context.

| File | Purpose |
|---|---|
| [questions.json](questions.json) | Current submission questions and reference criteria |
| [questions-v1.json](questions-v1.json) | Earlier question-set snapshot, retained for provenance |
| [scenarios.json](scenarios.json) | Additional scenario questions for separate diagnostic runs |

Follow [run-evaluation.ts](../src/services/evaluation/run-evaluation.ts) to see how a set is loaded and executed. Running an evaluation makes provider calls; browsing these files does not.

Three similar-looking locations have different jobs: **`eval/` is input**, [artifacts/evaluation](../artifacts/evaluation/README.md) contains saved outputs, and [docs/evaluation](../docs/evaluation/README.md) explains the procedure and earlier investigations. [EVAL.md](../EVAL.md) is the submitted interpretation of measured results.
