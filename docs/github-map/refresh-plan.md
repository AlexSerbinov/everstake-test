# Keeping the GitHub map current — cheap refresh plan

## Goal
Detect which of the 15 tracked repos changed since the docs were last written, and update only those docs — without re-cloning or re-reading everything each time.

## Step 1 — one call, whole org
```
GET https://api.github.com/orgs/everstake/repos?per_page=100&type=public
```
Compare each tracked repo's `pushed_at` against the value stored in that repo's doc front matter (`last_commit` field, or a new `checked_at` field added for this purpose). **1 API call covers all 15 (69 total) repos.**

- Repos whose `pushed_at` is unchanged → skip entirely, no further calls.
- Repos whose `pushed_at` moved forward → candidates for step 2.
- Also re-check `archived`/`fork` flags here in case a tracked repo got archived, and re-scan the full list in case a new public repo appeared.

## Step 2 — per-changed-repo commit list
For each candidate repo:
```
GET /repos/everstake/{repo}/commits?since={last_checked_iso_date}&sha={default_branch}
```
This gives commit messages/authors/dates without downloading a diff. Cheap way to judge "is this cosmetic (README, dependency bump) or substantive (new file, new contract, renamed product)?" from messages alone — often enough to write a one-line changelog update.

## Step 3 — diff summary only when needed
If commit messages don't make the change clear (e.g. no descriptive PR title), pull a compare diff:
```
GET /repos/everstake/{repo}/compare/{old_sha}...{new_sha}
```
Use the `files` array (filenames + `patch` per file) — feed just the changed files' patches to the model to write an updated "Facts about Everstake it reveals" bullet or a dated changelog line. For a large diff, request compare with a `per_page`/pagination-aware client and only fetch `patch` for non-binary, non-lockfile files (skip `pnpm-lock.yaml`, `go.sum`, `node_modules`, generated `dist/`).

## Step 4 — update the doc
Model reads the existing `docs/github-map/<repo>.md`, applies a targeted edit (append to Facts/Dates, or note a superseded fact if content contradicts old text — never silently delete a fact, mark it "superseded as of DATE" instead), and bumps `last_commit` in front matter. Re-run this for `INDEX.md`'s activity column only if a repo's status bucket (active/stale/dormant) would change.

## Call & token budget
- **Daily check (all repos):** 1 call (org repos list) + 0 more if nothing changed. Rate-limit friendly even unauthenticated.
- **Per changed repo:** 1 call for `commits?since=`, +1 call for `compare` only if needed → 1-2 calls/changed repo.
- Given org history (most repos are dormant), expect **0-2 repos with new commits per week** in steady state; `wallet-sdk` and `mcp` are the two consistently active ones and worth checking more eagerly.
- **Tokens per changed repo:** a `compare` diff for a typical small PR (1-5 files) is roughly 500-3,000 tokens of patch text; summarizing that into a 3-5 bullet doc update costs on the order of 1,000-4,000 tokens total (input diff + output edit) per changed repo. A quiet week costs effectively 0 extra tokens beyond the 1 list call.

## Rate limits
- **Unauthenticated:** 60 requests/hour — sufficient for the daily-check pattern above (1 call/day) but too tight if you want to check more than ~1-2 times/hour or fetch many diffs in a burst.
- **With a personal access token (even no scopes needed for public repos):** 5,000 requests/hour — recommended once this runs on any kind of schedule (cron, CI), since it removes any risk of the org-list call competing with other GitHub API usage on the same IP.
- Send `User-Agent` on every request (GitHub requires it) and check the `X-RateLimit-Remaining` response header to back off proactively rather than waiting for a 403.

## Suggested cadence
- **Org-wide `pushed_at` check:** once daily is enough given how rarely most of these repos move; hourly is affordable even unauthenticated (60/h budget) if tighter freshness is wanted for `wallet-sdk`/`mcp` specifically.
- **Full re-clone + full re-read (this task's original process):** only if a repo's structure changes drastically (new top-level packages, license change, or `INDEX.md`'s summary judgments look wrong) — otherwise the incremental diff process above keeps docs accurate without ever re-cloning.
