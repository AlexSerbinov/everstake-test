# Choose an operator command

Run commands from the repository root. Ordinary setup uses [README](../README.md); routine collection and evaluation use `npm run cli -- <command>` in [src/cli.ts](../src/cli.ts). The files here handle narrower operator tasks.

| Task | File | Effect when run |
|---|---|---|
| Verify packaged files and local links | [check-repository.ts](check-repository.ts) | Checks required inputs, local links and folder README coverage; no model calls |
| Draw documentation PNGs | [docs/README.md](docs/README.md) | Writes images; no model calls |
| Back up the database | [backup-database.ts](backup-database.ts) | Writes a consistent copy to a new destination |
| Prepare a frozen corpus manifest | [freeze-corpus.ts](freeze-corpus.ts) | Rebuilds the local text index with sanitized documents and writes a manifest; this changes the database |
| Load saved evaluation or MCP runs | [import-evaluations.ts](import-evaluations.ts), [import-mcp-measurements.ts](import-mcp-measurements.ts) | Writes local database records from saved files |
| Discover, select or transcribe videos | [youtube.ts](youtube.ts) | Mode-dependent downloads, local writes and paid transcription |
| Review existing video speakers | [review-youtube.ts](review-youtube.ts) | Model calls and readable export writes; cached reviews may be reused |
| Import or activate video evidence | [import-youtube.ts](import-youtube.ts), [activate-youtube.ts](activate-youtube.ts) | Updates the corpus; activation may call embeddings |
| Run the MCP comparison | [evaluate-mcp.ts](evaluate-mcp.ts) | External calls and saved measurement writes |
| Check a model's availability | [probe-model.ts](probe-model.ts) | A real provider request, potentially paid |
| Export grades or costs from a database | [publish-evaluation.ts](publish-evaluation.ts), [publish-costs.ts](publish-costs.ts) | Rewrites root reports and/or saved artifacts; inspect output before replacing the curated submission |
| Recreate the original evaluation selection | [prepare-evaluation.ts](prepare-evaluation.ts) | Historical tool: requires the old prototype checkout and overwrites `eval/questions.json` |
| Deploy the recorded code | [deploy.sh](deploy.sh) | Publishes to the configured personal server; unnecessary for local review |

“Publish” in the report exporters means writing files, not pushing GitHub or deploying the app. Current root reports contain curated explanations of multiple saved snapshots; regenerating one from a different database does not preserve those editorial decisions automatically.

See the [operator guide](../docs/OPERATIONS.md) for arguments and the [YouTube guide](../docs/youtube/README.md) for the video sequence. Credentials are read from the environment; saved artifacts and examples should never contain them.
