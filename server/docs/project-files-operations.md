# OL-33 environment and operator handoff

The API contract is [project-files-contract.md](project-files-contract.md).
This package is for the people Master assigns to OL-35 (environment) and OL-36
(migration/deployment); OL-37 records real runtime acceptance. It authorizes no
production action by itself. Use the exact reviewed commit SHA from PR #19 and
the final OL-33 handoff, not a moving branch tip.

## Environment requirements for OL-35

| Item | Required preparation |
| --- | --- |
| Database | Isolated PostgreSQL database, current product migrations, a migration-owner connection and the normal application connection; primary reads for this service |
| Object storage | Existing S3/MinIO endpoint and a **distinct private bucket**, with no anonymous/CDN policy or expiry of referenced data; ordinary `S3_BUCKET` remains configured |
| App identity | Existing authentication/JWT configuration, test workspace, member and project, and task tokens minted by real task claiming for OL-37 |
| Network | API can reach PostgreSQL and MinIO; test clients/runtimes can reach the authenticated API; direct anonymous bucket download must fail |
| Proxy | Permit PUT/POST and required headers; body limit at least the configured file limit; upload/download timeouts aligned with the app; disable caching for these routes |
| Evidence | Record PG/MinIO versions, bucket policy verification, reviewed SHA, test project identifiers and outcomes; never include credentials, token hashes or connection strings |

No FUSE, plugin installation, new runtime mount, public download endpoint or
background queue is required. Task-scoped access and authorship are checked by
the API. CLI/runtime discovery is OL-34, not implemented by this PR.

Configuration (new settings are opt-in; changes require restarting the API):

| Variable | Default / allowed values |
| --- | --- |
| `MULTICA_PROJECT_FILES_ENABLED` | Unset/off; only literal `true` enables |
| `MULTICA_PROJECT_FILES_BUCKET` | Required when enabled; distinct from `S3_BUCKET` |
| `MULTICA_PROJECT_FILES_READ_ONLY` | `false`; set `true` for preserving reads and denying new mutations |
| `MULTICA_PROJECT_FILES_MAX_BYTES` | 67108864 (64 MiB); 1–1073741824 bytes |
| `MULTICA_PROJECT_FILES_UPLOAD_TIMEOUT` | `5m`; `1s`–`30m`; also bounds object downloads |
| Existing storage settings | `S3_BUCKET`, `S3_REGION`, `AWS_ENDPOINT_URL`, `S3_USE_PATH_STYLE`, standard AWS credentials/provider chain |
| Existing application settings | `DATABASE_URL`, normal auth and API/proxy configuration |

The server reuses the existing S3 client with the private bucket; it never falls
back to attachment/local storage for this feature. Invalid limits, missing S3 or
the same bucket name disable the endpoints (503 `PROJECT_FILES_DISABLED`). A
different name alone does not prove privacy: OL-35 must test the actual policy.
SDK uploads include `If-None-Match: *`, `private, no-store` and attachment
disposition. Verify conditional PUT support on the installed MinIO version.

Additional runtime minimum privileges:

- S3: `s3:PutObject` and `s3:GetObject` on the private bucket's `project-files/*`
  prefix. No public ACL, delete, bucket-policy, bucket-creation or list permission
  is needed by the file service. Add KMS permissions if the chosen bucket uses KMS.
- Database: SELECT/INSERT on the five new tables; UPDATE on `project_file`,
  `project_file_operation`, `project_file_candidate`, `project_file_upload`.
  Versions are insert-only. No runtime DDL is needed.
- Existing project/member/user/PAT/task-token/agent/run/issue/chat rows are read
  and locked. PostgreSQL locking SELECTs require the existing application's
  SELECT and UPDATE privileges on those rows/tables. Reuse the application role
  and verify its grants; do not grant a runtime access to the database or S3.
- Migration principal: ownership/DDL authority for new tables and indexes, plus
  the normal repository migrator's privileges. The app does not create buckets.

Credentials are supplied through the environment's secret injection mechanism.
Do not put them in command arguments, source, attachments, PRs or run logs. Use
`.pgpass`/`PGSERVICE` and equivalent tooling support when invoking `psql`, rather
than displaying a URL with embedded credentials. Do not run shells with `set -x`.

## Build and migrate a reviewed version

Start in a clean dedicated repository checkout. The operator sets
`OL33_REVIEWED_SHA` to the reviewed full SHA, injects `DATABASE_URL` for the
approved isolated target, and sets `PGSERVICE` to the equivalent psql connection
in a private service file. Do not copy the local development database URL.
The migrator and some existing tests otherwise fall back to a local development
database when `DATABASE_URL` is absent. The guards below stop that fallback;
the operator must also confirm that the selected database and role match the
approved target before migrating.

```bash
set -e
: "${OL33_REVIEWED_SHA:?Set the reviewed full commit SHA}"
: "${DATABASE_URL:?Inject the approved isolated database connection}"
: "${PGSERVICE:?Select the equivalent approved psql service}"
git fetch origin
git switch --detach "$OL33_REVIEWED_SHA"
git rev-parse HEAD
cd server
go build -o bin/migrate ./cmd/migrate
go build -o bin/server ./cmd/server
psql -X -v ON_ERROR_STOP=1 -c 'SELECT current_database() AS database, current_user AS role;'
./bin/migrate up
psql -X -v ON_ERROR_STOP=1 -f scripts/project-files-verify.sql
```

Expected: `HEAD` equals the reviewed SHA; migration 452 creates five tables,
453–462 build ten indexes, and verification prints
`project file metadata invariants OK`. Every index has its own concurrent
single-statement migration and registered invalid-index retry cleanup. Do not
wrap migration files in an external transaction. All directions are provided;
schema introduces no foreign keys or cascading actions.

If a migration fails, keep the feature disabled and inspect the failed migration.
For an interrupted concurrent index build, rerun the **same reviewed migrator**:
its existing cleanup mechanism removes the invalid index before retrying. A
recorded migration alone is insufficient proof: the verification script checks
that every new index is present and usable. Do not edit `schema_migrations` to
force success or proceed on an invalid index.

On the approved test deployment, inject the new configuration with read-only
enabled initially. Launch the built `bin/server` using that environment's
existing supervisor/container wiring; `./bin/server` is the foreground process
entrypoint. The exact supervisor service name/restart command is environment
owned and must be supplied by OL-35/36; this package does not guess or replace
the workspace daemon's process. Record the deployed binary SHA. After a member's
capabilities request succeeds, enable writes and restart the same reviewed
binary for the validation below.

## Reproducible validation

Local/API suite: `PROJECT_FILE_TEST_DATABASE_URL` must explicitly point to the
isolated migrated database. It is intentionally not inferred from `DATABASE_URL`.
For repository handler/middleware tests, set `DATABASE_URL` to that same isolated
database. The suite creates disposable workspaces/projects; never use production.

```bash
set -e
: "${DATABASE_URL:?Inject the isolated test database connection}"
: "${PROJECT_FILE_TEST_DATABASE_URL:?Explicitly select the same isolated test database}"
go test -race ./internal/projectfile -count=1 -v
go test -race ./internal/handler -run '^TestProjectFile' -count=1 -v
go test -race ./internal/auth ./internal/middleware ./internal/storage ./internal/migrations -count=1
go test ./cmd/server -run '^TestProjectFileConfiguration$' -count=1
go vet ./internal/projectfile ./internal/handler ./internal/storage ./internal/middleware ./cmd/server ./cmd/migrate
```

The full `cmd/migrate` test package is a separate **administrator-only regression
suite on a disposable database**, not a minimum-privilege application or
deployment-role acceptance check. Its existing
`TestIssuePropertiesBigramIndexBuildsOnlyWherePGBigmExists` reads `pg_statistic`
in `cmd/migrate/migrate_issue_properties_bigm_index_test.go`; the default
PostgreSQL grants deny that read to an ordinary role. Run it with a separately
injected disposable-database superuser connection. Do not elevate the deployed
application role or grant it catalog access to make this test pass. A permission
failure here does not demonstrate a project-file migration failure.

```bash
# Separate test shell with DATABASE_URL injected for the disposable admin role.
set -e
: "${DATABASE_URL:?Inject the disposable admin test database connection}"
go test -race ./cmd/migrate -count=1
```

Record this admin suite as SKIP if that isolated connection is unavailable.
OL-36 still verifies the reviewed migrations with the migration-owner role and
`scripts/project-files-verify.sql`, and OL-37 tests application access with the
normal role. Prior author validation of the full migrator suite used the
isolated cluster's administrator role; it was not evidence of minimum privileges.

From the repository root:

```bash
make sqlc
pnpm --filter @multica/core exec vitest run api/project-file-schemas.test.ts
pnpm --filter @multica/core typecheck
```

Expected: `TestReviewAdoptSuccessReplayComplete` and all other selected tests pass;
100 synchronized text/binary writer pairs each preserve exactly one current
revision, one candidate, and their prior history. Revocation/expiry tests confirm
no final version is committed. Body/digest mismatch never becomes a successful
replay. Lost upload/commit replies are recovered under the original key without
duplicate versions. Auth HTTP tests cover spoofed identity headers and run scope.

Real PG + MinIO roundtrip suite, after OL-35 explicitly provisions the private
**disposable test bucket** and injects the S3 settings above:

```bash
set -e
: "${DATABASE_URL:?Inject the isolated test database connection}"
: "${PROJECT_FILE_TEST_DATABASE_URL:?Explicitly select the same isolated test database}"
: "${PGSERVICE:?Select the equivalent isolated psql service}"
PROJECT_FILE_TEST_S3=1 go test -race ./internal/projectfile -run '^TestProjectFileS3Integration$' -count=1 -v
psql -X -v ON_ERROR_STOP=1 -f scripts/project-files-verify.sql
```

This runs 100 binary save/conflict/adopt/replay/history rounds against real S3.
Without the opt-in it reports SKIP, which is not MinIO validation. It removes
its fixture metadata but leaves private test objects for operator inspection;
the operator may remove this **disposable bucket** after recording results. The
application has no automatic GC or object-delete privilege.

Deployed API and OL-37 acceptance (use clients with environment-injected auth):

1. Anonymous file/candidate requests fail. A valid member gets capabilities;
   a run in another project gets denied even if its owner is a workspace member.
2. Save a UTF-8 document and a binary file using their actual SHA-256/length and
   base revision. Re-read and verify headers, complete length and SHA-256.
3. Have two independently authenticated clients edit the same revision; exactly
   one updates the head, the other receives 409 CONFLICT with readable bytes.
4. Adopt with a deliberately stale expected revision. Move the head again,
   retry the original key, and verify every result field (except `replayed`)
   stays unchanged. Adopt with a fresh key/reviewed revision and repeat the
   complete successful replay comparison; `candidate_id` must stay absent.
5. Interrupt a response after commit, query its operation, retry unchanged and
   confirm no second version. On 202, preserve local content; no background
   worker finishes the intent automatically.
6. Use a **local PAT or task token** for upload-window token revocation/expiry
   tests; also revoke membership/end a real run and verify final commit is
   denied. A JWT's authenticated `exp` is rechecked before commit, so test JWT
   expiry separately. JWT session revocation at its provider and cloud-PAT
   revocation after request-entry authentication are not rechecked during this
   request; do not use them as substitutes for the local-token cases. Test
   project reassignment, cross-workspace IDs and every read/candidate/replay
   entry. Verify recorded author and task IDs.
7. Repeat through the real proxy with 1 KiB/1 MiB/100 MiB data after explicitly
   increasing the configured file limit for 100 MiB. Record latency, memory and
   digest evidence; no production capacity promise is inferred from unit tests.
8. OL-34/37 use two real runtimes from normal task startup to discover the tools,
   list, read, edit, save and observe conflicts. Initial briefs must contain
   neither the complete tree nor full content. This is still required even
   when all backend tests pass.

Record command, reviewed/deployed SHA, versions, sample size/digest, operation ID,
first result and replay result, and PASS/FAIL/SKIP. No credentials or token hashes.

## Rollback and data retention

First set `MULTICA_PROJECT_FILES_READ_ONLY=true` and restart the reviewed API.
Expected: reads and completed-result replay work; new saves/adopts return
403 READ_ONLY. Retain all five tables and private objects. Export needed content
through authenticated reads. An upload begun on an old process must finish or
be drained before declaring the rollout read-only across all instances.

If the new API itself cannot run, disable the feature or roll back the binary
using the environment's existing deployment procedure. Old binaries have no
file endpoints, so data remains preserved but shared-file access is unavailable
until the reviewed binary is restored. Do not run `migrate down` on populated
tables and do not delete/expire objects. The down migrations are for reversing
an unused installation, not for production data rollback.

Project deletion makes retained files inaccessible; retained metadata/objects
are deliberately not cascaded or garbage-collected in this batch. Disposable
acceptance writes may proceed under the environment owner's control. Before
enabling writes for real project resources, a later batch must implement and
verify limits per project and actor (member/run): total retained bytes and
versions/candidates, pending upload attempts and concurrent uploads. Accounting
must include failed-upload intents and unreferenced objects, with concurrent
limit enforcement and a documented recovery path for rejected writes. Owners
must choose the limits from capacity evidence; this PR sets no quota or GC.
Retention policy and paired PostgreSQL/object backup restoration are also
required before that rollout. GC, full recovery drills, directory UI and edit
leases remain outside OL-33.
