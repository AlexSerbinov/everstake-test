# UI integration and layout review

Date: 2026-09-13. Review base: `7eed6e5`. Scope: browser code against the integrated API, evaluation and measurements contracts; live read-only checks against `http://localhost:4318`. This was a separate integration pass by the UI agent, not a third-party review of the UI implementation.

## Confirmed findings and fixes

| Priority | Finding | Resolution |
|---|---|---|
| P1 | The evaluation screen calculated a percentage when the saved API explicitly returned `accuracy: null` for an incomplete assessment. | Display the saved accuracy. Show incomplete/unassessed states and separate planned, recorded, awaiting-assessment, request-error and not-run counts. |
| P1 | `summary.inventedFacts` counts flagged answers, while a row stores a boolean flag. The UI called the summary a fact count and converted `true` into exactly one invented fact. | Label the summary as answers with invented facts. A boolean flag no longer invents an exact number of factual claims. |
| P2 | Answer setup called `crypto.randomUUID()` before its error handler. Browsers without that secure-context method would leave the form busy before sending anything. | Use the existing request generation as a local DOM scope; no cryptographic identity is needed. |
| P2 | The skip-to-content link used `#main`, which the hash router interpreted as an unknown page and redirected to Ask. | Focus the main landmark without changing the selected route. Reproduced before the fix and verified afterward. |
| P2 | The live costs API deliberately returns `question: null`. Several entries therefore appeared as indistinguishable `query` headings. | Display a neutral activity label and short run ID. Do not reconstruct or expose redacted questions. |
| P2 | Collection/index receipts were labeled “Answer receipt”. | Use “Activity receipt” in the costs overview; retain “Answer receipt” beside actual answers. |
| P2 | The HTTP adapter can emit an error with the `request-error` sentinel after events carrying a real run ID. The stream reader discarded it as another run. | Accept that explicit adapter-error sentinel while continuing to reject unrelated normal run events. Preserve the error through EOF. |

## Verification

- TypeScript typecheck and browser build passed.
- 19 browser unit tests passed, including new regressions for incomplete evaluation metadata, redacted cost titles, local scopes and the adapter-error event.
- 47 backend tests passed in this worktree. Tests use their existing fixtures; this review did not invoke real model providers.
- The running application showed 935 collected documents at the time of inspection. Corpus pagination displayed 50 real document cards with published/updated/checked dates and duplicate labels.
- Browser checks at 390 × 844 and 1440 × 1100 found no horizontal overflow in the inspected views. Costs displayed actual saved receipts, unknown charges and an expanded nine-call breakdown. Evaluation correctly displayed its empty state before a saved run was available.
- Patched assets were checked through a local read-only proxy to the real GET endpoints. The proxy rejected every non-GET request. With `crypto.randomUUID` explicitly unavailable, submitting to that blocked local endpoint displayed an ordinary request error and cleared the busy state.
- Skip-link verification retained `#evaluation` and focused the `main` landmark. No browser runtime errors were reported. The review browser and local proxy were closed afterward.

## Limits

No paid question, evaluation or refresh was started by this review. Live production streaming and model correctness remain separate integration/evaluation work. Incomplete/mixed assessment states were exercised with deterministic saved-contract fixtures because the live evaluation list was empty when inspected. The UI reports the count of planned questions without saved answers; it does not fabricate missing question identities or combine them with a different live question-set revision.
