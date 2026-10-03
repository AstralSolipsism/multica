# OL-103 verification record — 2026-10-03

Contract and implementation boundaries: [skill package contract](labrastro-skill-packages.md).
Base: `803cfcf18a7db98ee45e7ac10367b12a4c773711`. Linux, Go 1.27.1,
PostgreSQL 15 on a task-owned local cluster and isolated development database.
No tests imported skills into the connected Labrastro workspace.

## OL-106 integration rework

The source-classification code under test is
`d6988b89af13207e64cb711d60c5483f46c00c80`, appended to the previously reviewed
`28eb1e838dc203a1c64cbfb4da2cbc8165c9c37c`. The accompanying changes to this
record and the contract are documentation only. This section supersedes earlier
results for the changed handler; earlier test runs below remain historical.

Environment: Linux, Go 1.27.1, PostgreSQL 15.19, task-owned loopback cluster on
port 55483 and isolated database `ol103_rework`. The checkout's managed
`make up C=api` created/migrated that database; its API launch phase returned
nonzero and the process stopped. Tests used httptest handlers directly.
`make test` was attempted again and stopped at missing Docker in
`scripts/ensure-postgres.sh:72`. No production database was accessed.

### Reproduce, fix and preserve boundaries

The committed `labrastro_skill_packages_source_test.go` adds 17 scenarios.
Running it on unchanged `28eb1e838` first reproduced nine failures: preview
returned 200 on last-candidate cancellation/deadline; apply/rescan returned 409;
new primary/support/required-reference download failures also returned 409.
The other boundary scenarios, including the complete write-phase timeout
report, already passed. After the fix all 17 scenarios pass under `-race`:

- Last-candidate deadline and explicit cancellation return 504
  `source_timeout` for preview, apply and rescan, without persisting changes.
- Newly failed downloads with a valid token return 503 `source_unavailable`.
- A matching preview with an existing retryable candidate failure still
  creates the healthy skill and reports the failed selected item.
- True source/target/role changes, invalid/expired tokens during an outage,
  and nonretryable limit changes retain 409 `preview_stale`.
- A deadline after the first skill commits leaves that skill/placement saved,
  reports both remaining items as `source_timeout`, and returns all three
  results with `failed:true`; there is no write retry.

Pre-write assertions compare complete package snapshots, including skill/file
hashes, folders, placements, package candidates/revision/timestamps and role.
Partial-write assertions compare report IDs/statuses against persisted rows.
All fixture source requests stay offline.

The before/after command (through `scripts/go-test-with-agent-cli-guard.sh`):

```sh
go -C server test -race -json ./internal/handler \
  -run '^TestLabrastroPackage(ScanContextFailure|ApplySourceFailureClassification|WritePhaseTimeoutReport)$' -count=1
```

The full scoped run used a source copy of `d6988b89` outside the task marker,
with production task/token environment variables removed from test processes.
The runtime's actual task marker/credentials were not changed:

```sh
go -C server test -race -json ./internal/handler ./cmd/server ./cmd/multica ./cmd/migrate ./internal/migrations -count=1
```

| Package | Top-level passes | Existing gated skips | Elapsed |
| --- | ---: | ---: | ---: |
| `internal/handler` | 2,437 | 57 | 278.090 s |
| `cmd/server` | 318 | 0 | 53.099 s |
| `cmd/multica` | 469 | 0 | 18.857 s |
| `cmd/migrate` | 43 | 2 | 65.189 s |
| `internal/migrations` | 18 | 0 | 8.324 s |

Total: **3,285 passed, 59 skipped, zero failures**. New regressions, fixed
source fixtures, permissions/atomicity, external-token 403/route inventory,
migration lint and 9001–9008 up/down/interrupted-index tests all ran.
No SQL inputs changed, so sqlc was not regenerated in this revision.

The two pinned source tests also reran with 1 ms synthetic latency:

| Source | Candidates | Requests / recursive trees | Peak downloads | Cache bytes | Largest bundle bytes | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mattpocock `d81f3a1` | 37 | 105 / 1 | 6 | 259,010 | 19,436 | 564 ms |
| addyosmani `9d0c60d` | 25 | 42 / 1 | 4 | 468,587 | 48,479 | 800 ms |

Sampled process heap deltas were 11,279,688 and 13,269,880 bytes respectively;
these are process observations, not hard cache or memory limits. The scan
algorithm, candidate concurrency, token payload and budgets are unchanged.

### Actual 45-second probe and CLI contract

The OL-106 `slow_apply.py` scenario was adapted into a temporary handler test
using the same pinned mattpocock `skills/in-progress` subtree (six candidates).
It first previews without delay, then delays only raw-file responses. No
shortened request deadline is supplied, so this exercises the real server
45-second limit:

| Raw-file delay | Apply elapsed | Response | Database |
| --- | ---: | --- | --- |
| 4 s | 45.002 s | 504 `source_timeout`, retryable | Unchanged |
| 8 s | 45.005 s | 504 `source_timeout`, retryable | Unchanged |

This is an in-process HTTP handler probe, not a browser/Next.js proxy test.
The permanent regression uses a one-second parent deadline for faster coverage
of the exact last-candidate failure path.

For CLI compatibility only, the verification source copy overlaid #59's seven
changed files from `b31a975f5810c78bea873b43f3c3746c25871be9` onto `d6988b89`.
No frontend code or combined delivery branch was created/pushed. A temporary
CLI probe checked 503 `source_unavailable`, 504 `source_timeout` and 409
`preview_stale`: one preview plus one apply, the complete error object on
stdout, nonzero exit, and no source error mislabeled as an apply conflict.
The existing delayed-server/partial-report/no-retry CLI tests also passed.

```sh
git diff --binary 28eb1e838dc203a1c64cbfb4da2cbc8165c9c37c b31a975f5810c78bea873b43f3c3746c25871be9 > ol105-contract-overlay.patch
# Apply only to the disposable verification copy, then add the two probe
# test files from the issue's evidence archive to their respective packages.
git apply /path/to/ol105-contract-overlay.patch
go -C server test -race -json ./internal/handler ./cmd/multica ./internal/service \
  -run '^(TestLabrastroIntegrationSlowApplyProbe|TestLabrastroSkill|TestLabrastroCLIReworkSourceErrors|TestBuiltin)' -count=1
```

All selected tests passed without skips: one handler top-level test (two
45-second cases), 20 CLI top-level tests and three builtin-skill tests.
The probes, wrapper, before/after logs, full scoped race JSON and backup
rehearsal log are attached to the OL-103 handoff. These are implementation
checks; they do not replace the new independent reviews or OL-106 integration.

### Backup/restore rehearsal

`backup-rehearsal.py` and `backup-fixture.sql` in the issue's evidence archive
implement the contract's runbook on a separate synthetic database. The fixture
contains a completed skill, a shared reference, creator/workspace/agent/label
records, bindings and all three package tables. `pg_dump --format=custom
--no-owner --no-acl` succeeded; `pg_restore --list` included all seven relevant
table data sections. `pg_restore --exit-on-error --single-transaction
--no-owner --no-acl` restored it into two newly created databases.

Both restores matched all 12 table counts and complete-row digests, covering
the seven skill tables plus user/workspace/agent/label identities and migration
metadata (empty in this schema-only synthetic fixture). The first restored
copy was then deliberately overwritten and its `_shared/*` rows deleted.
The second fresh restore recovered the original content and files exactly,
including IDs, creator, bindings, labels and package candidate metadata.
No destructive rehearsal command targeted the managed test database or a real
workspace. This revision did not rerun the old server's refresh hazard; that
observed behavior is attributed to the OL-106 integration review in the contract.

### Coverage limits

This is not an all-repository green claim. Docker-dependent `make test` could
not run; unchanged daemon/agent process suites and frontend/Electron/browser
E2E were not repeated for this server/documentation fix. Their previous results
are not treated as new-head passes. No real agent CLI, live GitHub source,
Windows, deployment or real-workspace import was exercised. The 45-second
full-scan limitation remains explicitly documented.

## Initial delivery checks (`c246a57`)

- `make sqlc`: regenerated the three models and fork query file.
- `go test -race ./cmd/migrate ./internal/migrations`: passed in the full
  isolated suite, including migration audits and the new up/down/up test that
  repairs an interrupted unique-index build. New indexes each have one
  concurrent-statement migration and a cleanup hook.
- Router suite passed. The regenerated external route inventory contains 14
  new `user-auth/deny` entries. `TestExternalConversationEveryDeniedProductionRoute`
  exercised actual external tokens and verified 403 for every denied route.
- Full `./internal/handler`, `./cmd/server`, and `./cmd/multica` race suites
  passed in a source copy outside the runtime task marker, with task identity
  environment variables removed from test processes. The original task marker
  and credentials were not changed. This full run preceded the final code-block
  parser refinement; the final scoped run repeated the affected coverage.
- Final scoped handler race run passed 163 top-level tests in 10.4 seconds:
  `-run '^(TestLabrastro|Test.*Skill|TestFetchFromGitHub|TestFetchFromSkillsSh|TestWorkspaceDeletionManifest|TestDeleteWorkspace)'`.
  This includes nested code-block/escaped-path, HTTP diagnostic and sibling-archive
  regressions, old skill/refresh tests, and workspace cleanup regressions.
- `pnpm --filter @multica/core typecheck`: passed.
- `pnpm --filter @multica/core lint`: zero errors, two existing warnings in
  `platform/core-provider.tsx` (unused disable and memo dependencies).
- `pnpm --filter @multica/core test`: 189 files, 2,412 tests passed. New schemas
  keep malformed write results indeterminate and unknown statuses unsuccessful;
  old skill responses still parse without diagnostics.
- `git diff --check`: passed.

Functional coverage includes recursive/anchored/back references, untouched
missing examples and fenced blocks, symlinks/filtered assets, final byte/file
limits, failed required downloads, `_shared` collisions, subtree-only requests,
manifest defaults, read-only previews, role changes, cross-workspace requests,
adoption preserving identity/creator/config/labels/bindings, name conflicts,
ref changes, candidate removal/new selection, concurrent apply/tree movement,
per-item rollback, atomic delete failure, detached-skill survival, and workspace
teardown. HTTP tests verify that old import/refresh responses expose fallback
warnings and required-reference errors without persisting failed refreshes.

## Full-suite limitations

`make test` was attempted and stopped in `ensure-postgres.sh` because this
container has no Docker executable. The database had already been created and
migrated through the managed development environment against a separate native
PostgreSQL cluster. The same `scripts/test-go.sh --race` suite was then run
against that database with the repository's real-agent CLI guard enabled.

The first run also exposed task-marker assumptions in existing CLI/claim tests.
Repeating from an isolated source copy removed those failures. Full Go is not
claimed green: the concurrent run still failed two unchanged process tests:

- `TestProvisionDshMulticaProfile_CancellationKillsTheWholeTree`: also reproduced
  on the unmodified base commit. The reported grandchild was a zombie (`Z`,
  parent PID 1) when inspected, not a running writer.
- `TestOpenclawActiveConfigPathSpendsOneBudgetAcrossBothAttempts`: exceeded its
  300 ms timing expectation under the full concurrent suite; the isolated
  baseline and current tests both passed when rerun alone. No daemon or execenv
  code is changed by OL-103.

Because the regular group exits on failure, the message-delivery and agent
groups were explicitly run separately through the same guarded scripts.
The message-delivery race suite passed (121.9 seconds). The agent group failed
three Cursor process-group capture tests with `invalid argument`, and the
`budget`/`multiple` cases of `TestCursorBackgroundLifecycle` could not confirm
process cleanup. All these failures also reproduced on the unmodified base
commit (that replay additionally failed `finish`/`cancel` cleanup). This feature
does not change `pkg/agent`, daemon/execenv code, `go.mod`, or `go.sum`.

Web/desktop UI, CLI package command behavior and E2E flows belong to OL-104/105
and integration review; this phase changes only their shared wire schemas.
Remote CI is not substituted for local results and is not awaited here.

## Offline source measurements

Fixed commits are documented with notices in
`server/internal/handler/testdata/labrastro-skill-packages/README.md`.
Transport latency was simulated at 1 ms per request. These are local test
observations under the race detector, not Internet latency promises.

| Snapshot | Candidates/defaults/shared users | Requests / recursive trees | Peak downloads | Retained cache bytes | Largest completed bundle bytes | Sampled peak heap delta | Elapsed |
|---|---|---|---|---|---|---|---|
| mattpocock `d81f3a1` | 37 / 27 / 0 | 105 / 1 | 6 | 259,010 | 19,436 | 6,242,192 bytes | 518 ms |
| addyosmani `9d0c60d` | 25 / 25 / 11 | 42 / 1 | 4 | 468,587 | 48,479 | 7,956,968 bytes | 721 ms |

Heap delta is sampled process-wide every 1 ms and includes unrelated test
activity; it is neither an exact peak nor the cache/bundle budget. The bounded
working data are an 8 MiB source cache plus one candidate's files at a time,
with at most eight raw downloads in flight; tree metadata and temporary
rewriting allocations are additional. Tests enforce tree reuse, cache budget,
and concurrency separately. A 1 ms context against a 1 s fixture response
aborts without writes; truncated trees fail, and scoped requests do not issue
the full repository recursive-tree query.

No merge, upstream PR, release, deployment or production skill mutation was
performed as part of verification.

## Review revision verification

The new regressions first failed against `c246a57`, reproducing local-name
rescan changes, packaged name-only collisions, selected same-source transfers,
missing optional manifest keys, explicit null values selecting everything,
and escaped `+` paths becoming spaces. They pass after the fixes. Additional
cases cover readoption after detach, content updates preserving local names,
upstream rename after deselection/repeated failure, and inferred names in both
repository-root and nested skills. Local directory references retain their
paths without a filter warning; external directory references remain diagnosed.

The final code ran through the real-agent CLI guard, in the same isolated source
copy and task-owned PostgreSQL database as above:

```sh
go -C server test -race -json ./internal/handler ./cmd/server ./cmd/multica ./cmd/migrate ./internal/migrations -count=1
```

| Package | Top-level tests passed | Top-level tests skipped | Elapsed |
| --- | ---: | ---: | ---: |
| `internal/handler` | 2,434 | 57 | 261.563 s |
| `cmd/server` | 318 | 0 | 47.447 s |
| `cmd/multica` | 469 | 0 | 18.974 s |
| `cmd/migrate` | 43 | 2 | 60.055 s |
| `internal/migrations` | 18 | 0 | 9.061 s |

All five packages passed: 3,282 top-level passes and 59 existing gated skips
(Redis, real pg_bigm, external-source integration, and scale tests). The new
regressions and the OL-103 database, reference, permission, migration and route
coverage were not skipped. `git diff --check` also passed. `make test` was
attempted again and stopped at missing Docker, so this is not a claim that the
entire Go suite passed. The unrelated process suites and unchanged frontend
were not rerun for this revision; their earlier results remain recorded above.
The task-owned database was stopped after verification.

Apply still scans all candidates before reproducing the preview fingerprint.
The current token contains a signed fingerprint, not recoverable candidate
summaries; eliminating that scan needs a different signed payload or a server
preview store. That optional optimization is not included in these fixes.
The existing 45-second deadline, eight-download limit and 8 MiB cache remain.
