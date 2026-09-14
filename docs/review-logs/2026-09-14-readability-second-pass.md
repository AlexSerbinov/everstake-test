# Second readability pass — 2026-09-14

The comparison base is the first private preview commit, `0f3c3c79cfc3b825d69b3e6f2f85f57d95bef6cf`. The original repository and its existing working changes were not overwritten. The combined cleanup remains uncommitted in a separate registered worktree of that repository.

## Changes

- Separate provider request formatting from metering, budgets, retries, and cancellation. Keep the existing public exports.
- Give CLI dispatch and source refresh explicit names and extract the individual steps of HTML collection, duplicate grouping, and video evidence preparation.
- Explain why checked network addresses, text limits, provenance, uncertain billing, and evidence eligibility are required.
- Extend the Ukrainian code walkthrough with the new navigation points.

## Validation

- `npm run check`: TypeScript checks and all **222 tests passed**, both in the editing copy and the publication copy.
- `npm run build:web`: passed in both copies.
- New subprocess tests exercise CLI statistics, a missing resume identifier, and default help without provider credentials.
- A new provider regression test cancels during retry backoff and verifies that a second request is not sent and the failed attempt retains unknown cost. The timer itself is not interrupted.
- Independent General review examined the complete second-pass diff, new files, relevant callers, and assignment requirements: no Critical, High, or Medium findings.
- The first private preview passed GitHub Actions. The second commit's workflow status is recorded by GitHub, rather than predicted here.

The first pass also passed an isolated Node 22 Docker check and browser smoke tests; these were not repeated for this backend readability pass. No paid provider calls or new model evaluation were run. Existing evaluation scores remain historical measurements, not new results for the refactored code.
