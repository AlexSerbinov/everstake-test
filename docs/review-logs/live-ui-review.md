# Live HTTPS UI review

Checked: 2026-09-13 15:13 UTC.
Deployment: https://everstate-knowledge-base.89-167-19-222.sslip.io
Code: `b9ddd2ff3cfc456b92aaf4ab88f041329f35c7cf`. Corpus: `corpus-eae2b2b23116`.

Result: no severe UI/API mismatch or layout regression found in this read-only pass.

- HTTPS opened without a certificate override; the browser reported a secure context and the health endpoint returned `ok` with the expected code version.
- Evaluation defaulted to `agent-37174f55`: **70.0%, 14/20 passed, 6 failed, 2 answers with invented facts**, all 20 assessed and 20 question cards displayed. Filtering failures showed six cards while retaining the 70% overall denominator.
- The full baseline remained selectable at **60.0%**. The historical agent run remained selectable at **75.0%**; it did not replace the newer 70% result as the default.
- A saved answer expanded into five source cards. Published, updated and checked dates were visible separately. Citation activation focused and highlighted the exact saved passage, with the original-source URL preserved in the link.
- Costs loaded the saved ledger and receipts. Corpus displayed **939 collected documents**, with 50 cards on the first page.
- Inspected at **1440 × 1100** and **390 × 844**. No horizontal overflow was detected on the inspected home, evaluation, costs, corpus or expanded-source views. No browser runtime errors were reported.
- All actions were read-only. This agent submitted no question, evaluation or refresh request, changed no shared database state, and made no Git mutation. The separate `ui-live` browser session was closed afterward.

Selected screenshots are retained in [artifacts/demo](../../artifacts/demo/): `live-evaluation-desktop.png`, `live-evaluation-mobile.png` and `live-saved-sources-mobile.png`. The actual-question screenshots and response in that directory belong to the coordinator’s separate smoke check.

This pass verifies rendering of stored evidence and measured results over the deployed HTTPS endpoint. The root agent owns the separate paid end-to-end question smoke; this report makes no additional claim about model correctness.
