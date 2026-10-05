# Historical dependency audit and recovery

Run this command against an explicitly selected, authorized database snapshot.
It never defaults to a database. `DATABASE_URL` must be set through the normal
credential mechanism; do not put its value in an issue comment or audit report.
Commands below run from the repository root.

```sh
go -C server run ./cmd/audit_issue_dependencies > dependency-audit.json
```

The default is a read-only repeatable-read transaction. The report includes
original rows, per-type counts, exact duplicate canonical edge IDs, unverified
IDs, workspace graph violations and a proposed normalized row set. It audits
all issues and relations, including dangling or cross-workspace endpoints.
It does not infer that an empty development database represents production.

Unverified data blocks that workspace's dependency API, not ordinary assignment,
content edits, ordinary (non-`with-dependencies`) creation without `blocked_by`,
or deletion. Reparenting checks the affected parent/canonical dependency
component; unknown `blocks` and `related` rows stay inert and remain available
to this audit. Invalid canonical data in that component requires repair before
reparenting. Dependencies are informational and never gate execution. A successful
ordinary operation is not a clean audit.

## Normalization and migration

Review every `unverified_ids` and `workspace_violations` entry first. Historical
`blocks` direction, self/ancestor edges, dangling endpoints and cycles require
an explicit data decision; this tool will refuse normalization while any are
present. `related` remains unchanged. Never reverse `blocks` automatically.

For exact duplicate `blocked_by` rows in an otherwise verified graph:

```sh
go -C server run ./cmd/audit_issue_dependencies -deduplicate -backup dependency-backup.json > dependency-normalization.json
```

Use a restored snapshot or a maintenance window. Mutations acquire ordered
workspace/catalog/structure locks and an exclusive relation-table lock. A new
0600 backup file is written and file/directory-synced before any deletion; an
existing backup is never overwritten. The lowest sorted row ID survives each
duplicate group. The backup retains every original row and the exact expected
normalized set. The output describes the pre-normalization audit and proposed
impact, not a claim that a later database still matches it. Run a fresh read-only
audit after normalization.

Migrations 463–466 add the audit table and separate concurrent indexes. They do
not rewrite relation rows and add no foreign keys. Migration 466 stops on
duplicate canonical pairs; the failure preserves data. After audited repair,
the migration runner's registered hook removes an INVALID leftover index before
retry, avoiding an `IF NOT EXISTS` false success. The index only covers
`type='blocked_by'`; a successful index build does not verify historical
`blocks` semantics or the graph. Audit remains required.

Check for canonical duplicates **before deploying migration 466**, not only
before enabling compound writes: they prevent the unique index from building.
Other unverified rows are preserved by these migrations. Compound dependency
writes are enabled in production; `DependencyService.WritesEnabled` is an
in-process switch used by tests, not an operator-configurable recovery gate.

The integration sample contains two identical canonical rows and one `related`
row: 3 original rows → 2 normalized rows, exactly 1 removed duplicate; recovery
restores all 3 rows with their original IDs. Unknown semantics and overwriting
an existing backup are tested as refusal cases.

## Recovery

Stop every server/worker process that can mutate this database before recovery
and keep them stopped until verification finishes. There is no production
configuration switch that disables relation writes. Use the deployment's normal
service stop/start commands and the explicitly selected maintenance database.
To undo only normalization, remove the canonical unique index using the
single-statement migration-466 down SQL outside a transaction, then restore:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/migrations/466_issue_dependency_blocked_by_index.down.sql
go -C server run ./cmd/audit_issue_dependencies -restore dependency-backup.json > dependency-restore.json
go -C server run ./cmd/audit_issue_dependencies > dependency-recovery-audit.json
```

Restoration requires backup schema version 1, the same database name and an
exact match between current relation rows and the backup's normalized set. It
inserts only missing original rows in one transaction. A stale or different
graph is rejected, so later edits are never overwritten by this command. A
database restored under a different name or independently modified after
normalization needs an explicitly reviewed recovery plan/full database backup.
Restoring duplicate rows means the canonical unique index cannot be rebuilt
until those duplicates are normalized again. Review the recovery audit, repair
or normalize as needed (using a new backup filename), then run the index's up SQL
explicitly: dropping it with the down SQL does not reset the migration ledger.

If a previous index build failed or was interrupted, first run the down SQL
again to remove the INVALID leftover index, then retry the up SQL. The manual
path does not run the migration runner's cleanup hook; `IF NOT EXISTS` can
otherwise report success while leaving the index unusable.

```sh
# Required before retrying a failed or interrupted index build:
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/migrations/466_issue_dependency_blocked_by_index.down.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/migrations/466_issue_dependency_blocked_by_index.up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_issue_dependency_blocked_by'::regclass;"
go -C server run ./cmd/audit_issue_dependencies > dependency-final-audit.json
```

The validity query must return `t`. A missing index or `f` means recovery is
incomplete, even if the up SQL exited successfully; the audit checks rows, not
index validity. Restart the services only after the index is valid and the final
audit succeeds.

The dependency down migrations remove the added indexes but deliberately retain
`issue_dependency_audit` and all historical relation rows. Reapplying 463 is
idempotent and retains the audit data. Workspace deletion remains the explicit
owner-level cleanup path. Stored historical admission records do not enable an
execution policy.
