# Trust: explain the strength of the selected evidence

Start with [score-evidence.ts](score-evidence.ts). `scoreEvidence()` receives the selected passages and answer-check results from [answer-question.ts](../answer/answer-question.ts). It returns no score when there are no passages or a check has failed.

The score has four visible components:

| Component | What the code counts |
| --- | --- |
| Authority | The configured source-authority levels of the selected passages. |
| Temporal evidence | Whether passages have publication or update dates; a fetch date does not qualify. |
| Grounding checks | The configured contribution after the supplied checks have no failures. |
| Independent evidence | Distinct duplicate groups, capped at four groups for the full contribution. |

Weights come from [policy.yaml](../../../assistant/config/policy.yaml). The returned component names and reasons are shown with the answer so a reader can inspect the arithmetic.

This is a heuristic, not a probability of truth. A dated passage is not necessarily recent, separate pages do not prove agreement, and this function does not itself perform support review. The [answer module](../answer/README.md) decides whether an answer passes its checks.
