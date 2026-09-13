# Transition to one TypeScript implementation

This branch continues the published main history at `3d85f20`. The existing Claude and Codex implementations are reference prototypes, not two dependencies of the new runtime. The owner's local committed prototype history is also retained on the local `archive/two-implementations` branch; uncommitted work remains in the original checkout.

## Development sequence

1. Explain the transition and preserve the assignment and supplied source list.
2. Establish a small TypeScript structure and shared source, evidence and accounting contracts.
3. Build repeatable corpus ingestion with coding-agent assistance for research and QA, then automatic refresh through the same code.
4. Add the selected YouTube/Soniox/Gemini pipeline, search, evidence validation and Trust Score.
5. Expose live search, dated source cards, per-answer and total costs, and the selected twenty-question evaluation.
6. Remove the old prototype folders from the active tree once the new implementation covers the required behavior; retain historical commits.
7. Publish measured results and concise submission documents, then integrate the complete development history without squash.

Commits describe actual completed changes with real timestamps. An accumulated snapshot does not prove hours worked. Model calls, deployment and evaluation are not implied by this document. The transition is implemented incrementally on dev. The prototype folders were retired from the active tree after their replacements passed integration checks; their commits and the original local checkout remain intact.

## Hosting target

Product name: **Everstate Knowledge Base**. Planned HTTPS hostname: `everstate-knowledge-base.89-167-19-222.sslip.io` on the owner's personal server. Use an independent application port, service and persistent data directory. Check DNS, TLS, proxy streaming and health before declaring deployment complete. Do not modify or stop the two existing demo services.
