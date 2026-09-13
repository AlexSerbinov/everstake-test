# Operator guide

For initial setup and the three system diagrams, start with the [README](../README.md). Run these commands from the repository root. Runtime state belongs in ignored `data/`; do not commit credentials or mutable databases.

## Ask and inspect

```sh
npm run cli -- ask "How has Everstake's positioning changed over time?"
npm run cli -- stats
npm run cli -- costs
npm run check
```

`ask` makes paid provider calls. `stats` and `costs` inspect the selected local database; they do not measure the remote demo. The API and evaluation use the same answering function. The browser exposes question progress, source cards, verification, costs and evaluation results.

## Refresh

```sh
npm run cli -- refresh everstake-com
npm run cli -- refresh-due
npm run cli -- refresh-resume JOB_ID
```

Use the job ID from the refresh output. Run one refresh worker against a serving database. A failed staging job leaves the active version intact; resume reuses compatible staged work. A fresh crawl can produce different facts and counts from the committed evaluation snapshot. The current code also has an operator-enabled scheduler, disabled by default; see [Updates](UPDATES.md). Do not infer the hosted configuration from local code.

To admit a new domain, edit [sources.yaml](../config/sources.yaml), including publisher, authority, reason and limits, then refresh that source ID. An unsupported format needs an extraction adapter with a fixture. Source content cannot grant itself more authority.

## Video discovery and processing

```sh
npx tsx scripts/youtube.ts discover
npx tsx scripts/youtube.ts inventory
npx tsx scripts/youtube.ts transcribe --db=data/youtube-batch.sqlite --ids=REVIEWED_VIDEO_ID
npx tsx scripts/youtube.ts reconcile-costs --db=data/youtube-batch.sqlite
npx tsx scripts/review-youtube.ts --ids=REVIEWED_VIDEO_ID
```

Replace the placeholder with a screened video ID. Discovery and inventory do not authorize processing every candidate. Transcription downloads selected audio and calls Soniox; speaker review calls Gemini. Retain the batch database and job IDs to resume rather than submit duplicate work. For an isolated batch, import its jobs/transcripts into the intended review database before running review there; the commands above are separate stages, not an automatic batch-to-serving import.

Transcription alone does not activate evidence. Follow the [YouTube guide](youtube/README.md) for import, eligible testimony, review and incremental activation. Uncertain identity remains explicit. Reconciliation reads provider usage; unmatched costs remain unknown. Topic notes described in [YOUTUBE_KNOWLEDGE.md](YOUTUBE_KNOWLEDGE.md) remain a proposal.

## Reproduce quality measurements

```sh
npm run cli -- eval agent
npm run cli -- eval baseline
```

Both commands make paid calls for all twenty questions. Freeze the corpus before comparison; save the code/config/corpus identifiers and receipts. Reference answers are evaluation inputs, never corpus documents. A subset such as `eval agent E01` is diagnostic and must not be reported as the twenty-question result.

The runner saves **pending** verdicts. A successful response is not a correct answer. Independently review the saved response against the reference rubric, including cited passages and completeness; mark invented-fact cases separately. Preserve provider failures and partial answers in the denominator. Existing reviews are coding-agent rubric audits, not human certification.

```sh
npx tsx scripts/publish-evaluation.ts grades.json
npx tsx scripts/publish-costs.ts
npx tsx scripts/import-evaluations.ts
```

`grades.json` must contain actual reviewed verdicts in the publisher's expected format; inspect [publish-evaluation.ts](../scripts/publish-evaluation.ts) before preparing it. Publishing rewrites the generated EVAL/COST documents. Importing evaluations writes saved results into the selected host's database for its Evaluation screen; it does not rerun questions.

Do not mix a later collection ledger with the frozen evaluation's corpus count. Unknown charges stay unknown, and 50× extrapolation remains a forecast with explicit arithmetic.

## Deployment and documentation

[scripts/deploy.sh](../scripts/deploy.sh) defines the existing independent demo deployment. Deployment is separate from running the commands above. Check HTTPS health, event streaming and source rendering when deploying; retain persistent data and the scope of the selected service.

[docs/images/README.md](images/README.md) explains how to regenerate the diagrams locally. The Python renderer is a documentation utility, not part of the Node.js application.
