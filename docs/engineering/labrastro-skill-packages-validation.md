# OL-103 verification record — 2026-10-03

Contract and implementation boundaries: [skill package contract](labrastro-skill-packages.md).
Base: `803cfcf18a7db98ee45e7ac10367b12a4c773711`. Linux, Go 1.27.1,
PostgreSQL 15 on a task-owned local cluster and isolated development database.
No tests imported skills into the connected Labrastro workspace.

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
