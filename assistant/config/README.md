# Application settings

Configuration files select models, source policies, research limits, update discovery, and YouTube processing rules. They keep changeable choices separate from the implementation.

These are non-secret settings. Credentials belong in environment variables; use the [root setup guide](../../README.md) and `.env.example` when running the application.

## Where to change behavior

- `models.yaml`: generation, extraction and embedding model IDs, provider connection settings, and a dated price snapshot. Keep secrets in the named environment variables. New models without a price are recorded as unknown cost. Restart long-lived provider clients after connection changes.
- `policy.yaml`: evidence/output bounds, per-run and per-process session spending ceilings, and Trust Score weights. Weights total 100; the score is a heuristic, not confidence calibrated against reality.
- `../agents/researcher.yaml`: research and repair turn limits. Its action list documents the four actions implemented in TypeScript; it is not a dynamic plugin registry.
- [sources.yaml](sources.yaml): provenance, inclusion reasons, seed URLs and crawl expansion. Authority 1 is first-party, 2 is reputable external reporting, and 3 is lower-confidence material. Even official statements still need appropriate dates and evidence.
- `update-discovery.yaml` and `youtube.yaml`: optional video discovery and processing rules, separate from website crawling.

`src/config.ts` validates policy, source and researcher values. `src/providers/provider-config.ts` validates models and prices. These readers do not cache files: malformed settings fail before the affected operation instead of silently using defaults. The answer code and provider clients can retain an already-loaded snapshot for an operation.

Website crawl limits belong to the CLI: `CRAWL_MAX_PAGES` defaults to 1000, with three concurrent fetches (`src/cli.ts`). They are not policy.yaml settings. Staged refresh has its own explicit options in `src/workflows/staged-refresh.ts`.

An embedding-model edit requires rebuilding vectors for that model. Query and index operations select the same configured model; mismatched model responses or vector dimensions fail visibly. A corpus with no embeddings can still use lexical search without a provider call.

## Read or edit one source

`sources.yaml` is ordinary YAML: one list entry per source, with comments explaining each field. Keep the stable `id` when changing its entry URLs; stored documents and update jobs refer to that identifier. `enabled: false` preserves an exclusion with its reason. `expand: true` allows link discovery within the crawler's scope checks, not arbitrary Internet access.

Changing a seed does not fetch it immediately. First run `npm run check` to validate the catalogue; use the operator's targeted refresh command only when you intend to collect and possibly embed new material.
