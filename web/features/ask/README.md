# Ask a question

Everything shown while asking a question lives here: the input, live progress, final answer, supporting passages, checks, errors, and exports. Start with `question-form.ts` and `answer-view.ts`; `web/app.ts` connects them to the server.

| When the reader wants to understand… | Open | What happens |
| --- | --- | --- |
| Entering or stopping a question | [question-form.ts](question-form.ts) | Builds the form and its busy state. A suggested evaluation question only fills the input. |
| Progress while waiting | [search-timeline.ts](search-timeline.ts), [elapsed-timer.ts](elapsed-timer.ts) | Shows server events and elapsed time. Search previews are not final citations. |
| The returned answer | [answer-view.ts](answer-view.ts) | Displays the status, dated claims, source cards, checks, score, and cost receipt. |
| Following a citation | [citation-navigation.ts](citation-navigation.ts), [source-cards.ts](source-cards.ts) | Maps stable evidence IDs to passages and groups passages from the same page. |
| A failed request | [request-error.ts](request-error.ts) | Explains provider or request errors separately from an evidence-based “no reliable answer.” |
| The evidence score | [trust-score.ts](trust-score.ts) | Displays the server's score contributions and limits. It is not a probability that the answer is true. |
| The answer checks | [verification-checks.ts](verification-checks.ts) | Shows server-provided checks; passing them does not independently prove factual correctness. |
| Copying an answer | [answer-export.ts](answer-export.ts) | Formats the existing result with dates and source links. It does not make another model call. |

The receipt renderer is shared with the Costs page and stays in [costs/cost-receipt.ts](../costs/cost-receipt.ts). The Evaluation page reuses the answer renderer for saved results. Files ending in `.test.ts` beside the helpers cover exports, citation identity and safe links, and timer cleanup.
