# OL-33 implementation review and validation

2026-09-08. Integration baseline: main `2893af49e`. This records the author's
review and local evidence for the implementation delivered in PR #19. It does
not replace independent acceptance or report a production deployment.

## System model and decisions

| Boundary | Decision and reason | Consequence / reassessment trigger |
| --- | --- | --- |
| Authentication → file service | Typed authenticated identity, then live DB authorization for every entrypoint and again before commit | Existing header consumers are unchanged. PAT revocation, task expiry/end, membership and project reassignment are enforced; cloud PAT authentication itself remains the existing external middleware contract |
| Upload → metadata | Commit the operation binding and a distinct upload intent, release locks, upload immutable bytes, then commit metadata in a second short transaction | Crashes may leave pending intents/unreferenced objects. Clients must preserve the original request; no GC may assume pending means abandoned |
| Concurrent writers | One project lock for all short metadata writes, plus conditional revision advancement and immutable results | Serializes cross-path operation keys without leaking uniqueness errors. Refine lock granularity only after measured project contention and rerunning the full race matrix |
| Save/adopt/replay | One typed request binding and one stored complete result; member or run scoped keys | Adoption keeps candidate ID in the binding but every SAVED response omits it. Request type, path, revision, size, type and digest changes under a key are refused |
| Content storage | Existing S3 client, distinct private bucket, conditional immutable PUT, authorized streaming GET | Requires operator-verified privacy/retention and MinIO conditional PUT support. No public URLs, storage credentials or full content in lists |
| Metadata / lifecycle | Five singular tables, no foreign keys/cascades; 10 concurrent indexes in separate migrations | Application transactions own relationships. Deletion of a project denies access while retained metadata/objects await the later retention/GC design |

Core locations: `internal/projectfile/service.go` (authorization, intent and
commit orchestration), `internal/projectfile/read.go` (bounded metadata and pinned
content reads), `internal/handler/project_file.go` (HTTP boundary),
`internal/auth/identity.go`, `internal/middleware/auth.go`,
`internal/storage/private_object.go`, `pkg/db/queries/project_file.sql`,
`migrations/452_*`–`462_*`. Paths here are relative to `server/`.

## Findings resolved before delivery

- Parent P2: `TestReviewAdoptSuccessReplayComplete` compares the whole first
  success with its replay and operation lookup. It passes; candidate ID stays
  in the binding, absent from both public SAVED results.
- Parent contract regressions were ported to the product model: bidirectional
  save/adopt key refusal, stable adoption conflict after head movement and
  candidate consumption, changed expected revision rejection, simultaneous
  different-path key reuse and expiry before final adoption commit.
- Final authorization explicitly checks the product PAT table's `revoked`
  boolean, not just token existence/expiry. The upload invalidation matrix
  includes setting that flag while content is in flight.
- Upload validation requires the storage adapter to consume the complete
  declared bytes before any version can commit. Replayed saves also validate
  the body instead of trusting its claimed digest.
- Migration cleanup registration was corrected to match the repository's
  unqualified index-name contract. Both the complete migrator suite and the
  specific cleanup mapping checks pass after the correction.
- Download bodies and slow HTTP clients have bounded lifetimes. Errors never
  return object-storage endpoints, token hashes or raw database diagnostics.
- CI explicitly opts the new service suite into its disposable PostgreSQL
  database; it will not silently skip the concurrency regressions for lack of
  `PROJECT_FILE_TEST_DATABASE_URL`.

The review checked tenant/actor boundaries, lock ordering and transaction
lifetime, immutable key ownership, replay binding and field stability, candidate
retention, request/stream limits, bounded paging, download headers, response
parsing, migration directions and retry cleanup. No remaining P0/P1 defect was
identified in this reviewed scope. Real storage and runtime acceptance remain
unverified below.

## Local evidence

Environment: isolated PostgreSQL 15 on loopback, full product migration chain
through 462; in-memory immutable object adapter for service fault/concurrency
tests; local HTTP S3 fixture for actual SDK request behavior. No existing
database or MinIO instance was accessed or modified. Final service/build/vet,
HTTP, auth and migration checks used Go **1.26.6**, matching the module's minimum
patch; preliminary checks also ran on the available Go 1.27.1.

| Check | Actual result |
| --- | --- |
| Full migration chain on empty isolated PG; metadata verification SQL | PASS; includes usable index checks and verification with committed, conflict, zero-byte and pending states |
| `go test -race ./internal/projectfile -count=1 -v` | 16 top-level local tests PASS; real S3 opt-in test SKIP |
| `TestConcurrentFileWriters100Rounds` | 100 synchronized pairs, alternating text/binary; each keeps one new current, one readable candidate and unchanged prior history |
| `TestReviewAdoptSuccessReplayComplete` | PASS; only Replayed differs across the complete results |
| `TestReviewAdoptExpiredBeforeCommit` | PASS; expiry injected in the final result-write window; head/candidate/version/ledger mutations roll back |
| Upload/finalization failures | PASS; lost upload response, pre-commit failure and lost committed response recover without duplicate versions |
| Upload-time authorization invalidation | 8 cases PASS: membership removal, token expiry/revocation, run end, project reassignment/deletion, agent archival, PAT revocation |
| Actual auth middleware + file HTTP handlers | 3 tests PASS; spoofed headers, required revisions, malformed JSON, size limits, binary headers, task project binding |
| Auth / middleware / storage / migrations / migrator package suites | PASS under `-race` after the cleanup registration fix |
| Private S3 adapter and configuration boundaries | PASS; conditional PUT prevents overwrite, private/no-store headers, bucket/config restrictions |
| Server, migrator and CLI builds; targeted `go vet` | PASS with Go 1.26.6 |
| TypeScript response boundary tests | 13 PASS; malformed success/conflict and inconsistent operation envelopes cannot acknowledge a save |
| `@multica/core` typecheck; new schema ESLint checks | PASS |

Commands, exact configuration and operator actions are in
[project-files-operations.md](project-files-operations.md). The test harness uses
the repository fixture/HTTP helpers and cleans only its own test rows. No
production benchmark or full-repository test pass is claimed. The rows above
are the author's results; the independent review is attributed below.

## Independent review suggestions and disposition

The independent OL-33 review on 2026-09-08 (comment
`01a07f32-96d1-721e-9c6f-ce4c7ed6026a`) approved implementation
`1bfaeadb85b543cc43cd60fd984ed7f899bb7720` without a P0/P1 finding.
The following disposition addresses all five non-blocking suggestions. It
clarifies the existing behavior and operator prerequisites; it does not add
new runtime behavior or claim additional environment testing.

| Suggestion | Disposition and source evidence |
| --- | --- |
| Credential revalidation boundary | Contract now distinguishes local PAT/task-token row revalidation from JWT/cloud-PAT authentication. JWT `exp` **is** copied by `internal/middleware/auth.go` and rechecked by `resolveActor` on final authorization in `internal/projectfile/service.go`; remote session revocation is not. Cloud-PAT identity carries no expiry and Fleet is not called again at commit. OL-37's upload-window revocation cases explicitly use local PAT/task tokens |
| Migrator test permissions | Operator commands separate the full admin-only `cmd/migrate` regression suite from application-role validation. The pre-existing statistics test reads `pg_statistic`; its default permissions require a privileged test role. Prior author runs used an isolated administrator role. Added explicit database guards because the migrator and existing tests otherwise select a default local database |
| Replay contention | Retain the v1 project lock on save/adopt retries. Correct the scope: `Service.Operation` already performs a scoped read after authorization and does not call `write()` or take the project write lock. Document lookup-first recovery. Measure project-lock wait time and retry-related timeouts in later load testing before changing mutation replay; any optimization must preserve binding, body validation, expiry and full-result replay |
| Unbounded candidates/intents | Record enforcement of project/actor limits as a prerequisite before real-resource writes: retained bytes, versions/candidates, pending attempts and concurrent uploads, including failed/unreferenced content. Concurrent accounting and rejection/recovery tests belong to the later quota/retention batch. Disposable C/D/E acceptance remains permitted; no GC or quota is claimed in v1 |
| Candidate timestamp | Contract and built-in project reference now state that candidate-list `updated_at` is its immutable creation time from `project_file_candidate.created_at` (`internal/projectfile/read.go`). Resolution removes it from the unresolved list. Keep the v1 field name; clients use revision/version IDs for working-copy concurrency |

The independent reviewer also disclosed that an initial migrator command without
an explicit `DATABASE_URL` advanced that reviewer's local development database.
That is separate from the author's isolated validation recorded above. This
follow-up does not connect to or roll back that database; the command guards and
target-selection instructions address the reported invocation hazard.

## Explicit pending acceptance

- OL-35/36: real PostgreSQL/MinIO permissions and privacy policy, installed
  MinIO conditional PUT behavior, reviewed-SHA migration/deployment and real
  proxy behavior. `TestProjectFileS3Integration` is executable and gated, but
  was not run against existing MinIO credentials in this task.
- OL-34/37: two actual runtimes from normal task startup, scoped identity,
  entrypoint discovery, revision-preserving working copies, conflict and
  uncertain-result handling. Backend handler tests do not substitute for this.
- Later batch: directory UI/operations, quotas/retention, automatic GC,
  coordinated backup restoration and edit leases. No automatic object expiry
  or cleanup is enabled before that work.

The API is disabled by default and ready for code review and isolated deployment
acceptance. Human acceptance and the environment-owned tasks determine when it
may hold real project resources.
