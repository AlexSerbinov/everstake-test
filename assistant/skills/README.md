# Guidance for comparing evidence

Open [evidence.md](evidence.md). It tells the researcher how to compare source authority, dates, copied claims and missing evidence. It supplements the action/answer instructions in [answer.md](../prompts/answer.md).

The [researcher definition](../agents/researcher.yaml) lists this skill, and [answer-question.ts](../../src/services/answer/answer-question.ts) loads it into the research request. There is no plugin installation or separate skill process.

For YouTube, speaker-attribution instructions live in [speaker-review.md](../prompts/speaker-review.md); the [video guide](../../docs/youtube/README.md) leads to the readable transcripts. They are distinct from this general evidence-comparison skill.

These instructions describe desired reasoning. Citation validation, numerical grounding and permitted actions are enforced in [answer code](../../src/services/answer/README.md). Changing this text requires checking answer behavior; it cannot change a historical evaluation score.
