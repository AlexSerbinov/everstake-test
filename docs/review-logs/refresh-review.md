# Refresh workflow review

Reviewed commit: `89ebb6c`

Scope: `src/workflows/staged-refresh.ts`, `src/workflows/refresh-corpus.ts`, `src/application.ts`, `src/api.ts`, their direct CLI wiring, schema/measurement helpers, and the existing staged/refresh tests. This was a read-only review of the live rebuild checkout. No corpus mutation, paid call, or repository edit was performed.

## Verdict

The normal success/failure path has a sound core: the serving documents, chunks, FTS rows, embeddings, and `corpus_version` are swapped in one SQLite transaction; a failed crawl or embedding pass leaves the serving corpus untouched; non-content tables such as `runs`, `api_calls`, `answers`, `evaluations`, `crawl_events`, and unrelated settings survive activation. Confirmed 404/410 pages are removed while unverified prior snapshots are retained. However, restart/resume is not yet safe enough to rely on operationally. One critical artifact-validation bug can replace the serving corpus with an empty or partial staging database, and the lease lacks ownership fencing.

## Findings

### 1. Critical — resume can activate a newly created empty or partial staging database

**Evidence:** `staged-refresh.ts:126-146,170-175`. A new job is persisted as resumable before `backup(db, job.stagePath)` completes. On every resume, backup is skipped solely because `previous` exists. `openDatabase(job.stagePath)` creates a database and schema when the file is absent; there is no existence, integrity, baseline-version, document-count, or embedding-completeness check before activation.

Two concrete failure paths follow:

- If the process or backup fails after the job row is saved but before a complete snapshot exists, resuming phase `crawl` opens an empty/partial database. A targeted crawl can then build an index containing only the selected source and atomically replace the full serving corpus with that subset.
- If a phase `embedding` or `activation` stage file is missing while its JSON report remains, resume opens an empty database, `embedCorpus` sees zero rows, and activation deletes all serving content. Because the empty stage has no `corpus_version`, the old version can remain next to an empty content set.

**Fix:** write the initial backup to a `*.partial` path, validate it, atomically rename it to the final stage path, and only then persist the resumable job/`snapshot_ready` phase. On resume, require the stage and report files expected by the phase; run `PRAGMA quick_check`; compare stored baseline/current version and expected document/chunk counts; and verify that every active chunk has the required embedding before activation. Missing or inconsistent artifacts must fail closed and leave the serving DB untouched. Add crash-window tests for missing backup, missing stage in `embedding`, and a targeted resume from an incomplete snapshot.

### 2. High — the lease is renewable by a worker that already lost ownership

**Evidence:** `staged-refresh.ts:28-47,107-138,175,194-199`. The lease identity is only the job ID. The heartbeat unconditionally overwrites `refresh_lease`; it does not compare the current owner, and activation does not re-check ownership.

If worker A pauses for more than 180 seconds, worker B may claim the expired lease. When A resumes, its queued heartbeat overwrites B's lease and both workers can continue. Their SQLite activation transactions remain individually atomic, but the last one wins, potentially publishing stale work. A finalizer can also clear a lease while another invocation is active. Per-process API `busy` does not prevent CLI or multi-process overlap.

**Fix:** give every invocation a random owner/fencing token distinct from the durable job ID. Renew and release only with a compare-and-set on that token, record lease loss instead of overwriting another owner, and assert ownership immediately before activation. A worker that lost the lease must abort without publishing. Test a paused worker, lease takeover, rejected old heartbeat, and rejected old activation.

### 3. Medium — content activation and completed/failed bookkeeping can disagree

**Evidence:** `staged-refresh.ts:175-193`; `application.ts:85-97`. The content transaction commits first. `source_checked:*`, `job.status = completed`, and the job save happen afterward. If any of those writes fails, the catch path records the job/run as failed and the API returns 500 even though the new corpus is already live. A crash in the same window leaves a running job with an activated corpus; resume is idempotent in the common case, but the reported state is temporarily false.

**Fix:** include source-check timestamps and the terminal job state in the same main-DB transaction as activation, or introduce an explicit `activated_pending_finalize` state that recovery can reconcile without reporting a generic failure. Keep measurement finalization separate if necessary, but never label a committed corpus swap as an ordinary failed refresh. Add a fault injection after activation and before job completion.

### 4. Medium — resume does not reconcile interrupted measurement rows

**Evidence:** `application.ts:80-97`; `staged-refresh.ts:16-24,94-107`. A process crash leaves its `runs` row `running` and may leave `api_calls` rows `pending`. The durable job does not record its owning run ID. Resume starts a new refresh run and never marks the interrupted run incomplete, so its receipt duration continues growing and the cost view can retain pending attempts indefinitely. Activation itself correctly preserves the ledger; the gap is restart reconciliation.

**Fix:** store attempt run IDs in `RefreshJob`. On resume/startup, mark the prior still-running run `incomplete` with a recovery reason and close orphan pending attempts as interrupted/unknown without inventing usage or zero cost. Preserve both old and resumed receipts and link them through job metadata.

### 5. Medium — a partial source refresh is scheduled as fully checked

**Evidence:** `refresh-corpus.ts:41-59,85-107,129-133`; `staged-refresh.ts:176-179`. A source is considered successful when it yields at least one document. Its other prior documents may be retained with `refreshStatus: not_rechecked`, yet the source is omitted from `failures`/`retainedSourceIds` and receives a fresh `source_checked:*` timestamp. `refresh-due` may then wait 24 hours for authority 1 or seven days for other sources before retrying the unverified pages.

**Fix:** return an explicit per-source outcome (`complete`, `partial`, `failed`) and count retained `not_rechecked` snapshots. Advance the full-check timestamp only for `complete`; schedule `partial` sooner or store per-document check state. Make `retainedSourceIds` include any source with retained, unverified documents.

### 6. Medium — completed refreshes retain full staging databases indefinitely

**Evidence:** there is no cleanup after `staged-refresh.ts:180-188`. The current checkout already contains one completed targeted job with a 280,584,192-byte SQLite stage plus its report (`data/staging` is 268 MiB). Completed jobs cannot be resumed, so repeated scheduled refreshes will grow disk use by approximately one full corpus database per run.

**Fix:** after successful activation, remove the stage SQLite file and its `-wal`/`-shm` files, retaining only compact job/report metadata if required for audit. Keep failed stages for a bounded resume window and add age/size-based cleanup. Cleanup failure should be recorded as maintenance debt, not change the already completed refresh to failed.

### 7. Low — invalid refresh selectors have misleading or dangerous fallbacks

**Evidence:** `api.ts:172-190`; `application.ts:69-73`; `cli.ts:29-43`. A non-empty unknown source is safely rejected before a run starts, but the API maps it to a generic 500 rather than a 4xx response. An empty-string `sourceId` is treated as omission because the application uses truthiness. More seriously, `refresh-resume` without `JOB_ID` passes no resume option and starts a new all-source refresh.

**Fix:** validate source IDs with `trim().min(1)` and use `sourceId !== undefined`; expose a typed unknown-source error as 400/404 while keeping internal failures at 500. Require exactly one job ID for `refresh-resume` before calling the application. Add zero-call tests for invalid and missing selectors.

### 8. Low — the empty-corpus 404/410 branch does not deactivate canonical-only matches

**Evidence:** `refresh-corpus.ts:86-90,108-124`. Retention correctly removes a document when either `document.url` or `document.canonicalUrl` is in `gone`, but the special branch used when nothing remains executes `UPDATE documents SET active=0 WHERE url IN (...)` only. If the gone URL matches only the snapshot's canonical URL, the branch can publish an `empty-*` version while leaving that document active. With the present 935-document corpus, unrelated retained documents normally send execution through `buildIndex`, so this is an edge case rather than an immediate production risk.

**Fix:** deactivate by both stored URL and `json_extract(snapshot, '$.canonicalUrl')`, or route the empty result through the same index activation primitive. Add a one-document alias/canonical 410 fixture.

## Verified invariants

- `activateStagedCorpus` swaps the four content/index tables and corpus version in one `BEGIN IMMEDIATE` transaction; SQLite rollback protects the prior serving state on an insert failure.
- It deliberately does not replace run/cost/evaluation/answer/crawl-event tables, so successful activation preserves the measurement ledger and historical answer receipts.
- Failed embeddings occur only in the stage; the serving database is not modified before activation.
- A source with no accepted replacement and no confirmed 404/410 produces no stage index change, and staged refresh rejects that result while retaining the prior corpus.
- Confirmed 404/410 URLs are the only fetch failures interpreted as gone. Other errors retain prior active snapshots and mark them `not_rechecked`.
- A non-empty unknown source ID cannot reach crawling or paid embedding code. API authorization and the in-process `busy` guard are in place, although the database lease remains the required cross-process control.

## Test coverage assessment

The existing tests cover successful content/ledger activation, failed embeddings preserving the live corpus, due-source timing, failed targeted refresh retention, and successful revision replacement. They do not exercise resume success, any crash boundary, missing/corrupt stage artifacts, lease takeover/fencing, post-activation bookkeeping failure, partial-source scheduling, completed-stage cleanup, missing CLI resume ID, unknown API source status, or canonical-only gone-page removal. Root reported 84 tests green; I did not rerun the whole suite because the final evaluation was active and this review made no repository changes.


## Remediation and retained limits

Commits `023ec7a` and `97d2b41` address the critical/high activation risks. A complete validated snapshot is renamed into place before publishing a resumable job. Resume refuses missing or incomplete snapshots. A per-invocation lease token fences activation, renewal and release. Activation checks the live baseline in the same write transaction, so an old failed job cannot overwrite a newer corpus. Regression fixtures cover each scenario, embedding coverage and preserved ledgers. CLI resume requires an explicit job ID.

Post-activation status reconciliation, per-page scheduling precision, and staging retention remain operational limits; no automatic completed-stage cleanup or unattended scheduler is claimed. These are distinct from the fixed corpus-loss paths. Final integrated test/deployment evidence is in EXECUTION.
