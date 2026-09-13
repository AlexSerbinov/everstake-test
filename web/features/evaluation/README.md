# Evaluation

evaluation-page.ts reads saved runs, overall metrics and verdict filters. question-result-card.ts presents difficulty, reference/actual answers and saved evidence. evaluation-page.test.ts protects the unfiltered denominator.

`default-evaluation-run.ts` selects the newest fully assessed 20-question agent run on first opening. It never selects by score; baseline, incomplete and historical runs remain available in the selector.
