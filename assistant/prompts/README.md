# What the model is asked to do

Open [answer.md](answer.md) first: it describes the researcher's allowed actions and expected answer format. Each other file serves a particular generation or review step. These are the actual texts sent to models, not examples of prompts.

| Step | Prompt files | Loaded by |
|---|---|---|
| Research an answer | [answer.md](answer.md) | [answer-question.ts](../../src/services/answer/answer-question.ts), through the researcher definition |
| Compare a single-retrieval baseline | [baseline.md](baseline.md) | The same answer module in baseline mode |
| Repair a rejected draft | [answer-repair.md](answer-repair.md) | The answer loop, together with failed checks |
| Check each claim against evidence | [verify-claims.md](verify-claims.md) | [verify-claims.ts](../../src/services/answer/verify-claims.ts) |
| Compare newer evidence or exceptions | [currentness.md](currentness.md), [scope.md](scope.md) | Focused claim review |
| Check the meaning of the complete answer | [answer-scope.md](answer-scope.md) | Whole-answer review after earlier checks pass |
| Require valid review JSON and retry bad formatting | [review-format.md](review-format.md), [review-retry.md](review-retry.md) | The focused-review request helper |
| Identify video speakers | [speaker-review.md](speaker-review.md) | [review-speakers.ts](../../src/services/youtube/review-speakers.ts) |
| Answer from the MCP comparison context | [mcp-answer.md](mcp-answer.md) | [evaluate-mcp.ts](../../scripts/evaluate-mcp.ts) |

The researcher also loads the [evidence skill](../skills/evidence.md). Prompts guide the model; TypeScript validates actions, citations, quantities and dates. A prompt edit can change answer quality even when the application still builds: review it against saved cases and measure a new evaluation before claiming improved accuracy. It does not retroactively update published results.
