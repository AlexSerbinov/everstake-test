---
name: judge
model: claude-haiku-4-5
prompt: prompts/judge.md
stage: judge
invoked_by: src/eval/run.ts (npm run eval)
---

# Judge

**Job.** Compare the system's answer to a hand-written reference for each of the 20 evaluation questions and return one verdict: `correct`, `partially_correct`, `wrong`, `hallucinated`, `abstained_correctly`, `abstained_wrongly`, plus a one-sentence reason.

**Deterministic overrides in code.** Abstentions are graded without the model: if the reference says "no answer exists" and the system abstained → `abstained_correctly`; if the reference has an answer and the system abstained → `abstained_wrongly`. The model only judges answered questions.

**Human override.** Each row in `eval/results/<run>.json` has `human_verdict: null`; set it and re-render (`npm run eval -- --render`) and EVAL.md marks the row "(human)".

**Why it is separate from the answerer.** The judge sees the reference answer; the answerer never does. Keeping them in different prompts and different runs prevents leakage from the eval set into the system under test.
