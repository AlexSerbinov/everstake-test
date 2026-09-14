# What each server module does

Follow the work in this order: **collect → prepare → search → answer → check**. These folders run in one Node.js process and share one SQLite database.

| Job | Folder | First file to read |
|---|---|---|
| Download permitted pages and record exclusions | [crawler](crawler/README.md) | [crawl-source.ts](crawler/crawl-source.ts) |
| Remove recognized instructions addressed to AI | [evidence](evidence/README.md) | [sanitize-document.ts](evidence/sanitize-document.ts) |
| Group copies and split text into passages | [indexer](indexer/README.md) | [build-index.ts](indexer/build-index.ts) |
| Prepare video testimony with named speakers | [youtube](youtube/README.md) | [pipeline.ts](youtube/pipeline.ts) |
| Find saved passages by words and meaning | [search](search/README.md) | [hybrid-search.ts](search/hybrid-search.ts) |
| Research a question and check the proposed answer | [answer](answer/README.md) | [answer-question.ts](answer/answer-question.ts) |
| Explain source confidence | [trust](trust/README.md) | [score-evidence.ts](trust/score-evidence.ts) |
| Browse stored sources in the UI | [corpus](corpus/README.md) | [browse-corpus.ts](corpus/browse-corpus.ts) |
| Queue manual and scheduled collection updates | [updates](updates/README.md) | [controller.ts](updates/controller.ts) |
| Record provider attempts, usage and costs | [measurements](measurements/README.md) | [api-calls.ts](measurements/api-calls.ts) |
| Run the evaluation question set | [evaluation](evaluation/README.md) | [run-evaluation.ts](evaluation/run-evaluation.ts) |

The [workflows](../workflows/README.md) connect collection and indexing into initial builds or safe replacements. The [provider clients](../providers/README.md) handle external APIs; feature modules decide what evidence is needed. A neighboring `*.test.ts` file checks that module with fixtures or fake providers.
