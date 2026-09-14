# One folder for each page

These six folders match the six pages in the navigation. Start with the page you see in the browser, then open its entry file.

| Page | Folder | Entry file | What the reader sees |
| --- | --- | --- | --- |
| Ask | [ask](ask/README.md) | [question-form.ts](ask/question-form.ts), [answer-view.ts](ask/answer-view.ts) | A question, live progress, the answer, sources, checks, and exports |
| Corpus | [corpus](corpus/README.md) | [corpus-page.ts](corpus/corpus-page.ts) | Saved documents, dates, excerpts, and collection activity |
| Costs | [costs](costs/README.md) | [cost-overview.ts](costs/cost-overview.ts) | Recorded API spending, unknown charges, and forecasts |
| Evaluation | [evaluation](evaluation/README.md) | [evaluation-page.ts](evaluation/evaluation-page.ts) | Saved test results and comparisons |
| Findings | [findings](findings/README.md) | [findings-page.ts](findings/findings-page.ts) | The published assignment documents |
| Updates | [updates](updates/README.md) | [updates-page.ts](updates/updates-page.ts) | Source settings and refresh jobs |

[The browser entry point](../README.md) connects these pages. A page may reuse another page's renderer: saved evaluation results use Ask's answer cards, and Ask uses Costs' receipt. General DOM helpers and stream parsing remain in `web/shared/` and `web/transport/`.
