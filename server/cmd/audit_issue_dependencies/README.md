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

The integration sample contains two identical canonical rows and one `related`
row: 3 original rows → 2 normalized rows, exactly 1 removed duplicate; recovery
restores all 3 rows with their original IDs. Unknown semantics and overwriting
an existing backup are tested as refusal cases.

## Recovery

Keep relation writes disabled and stop concurrent mutation while recovering.
To undo only normalization, first remove the canonical unique index using its
single-statement migration-466 down SQL, outside a transaction, then run:

```sh
go -C server run ./cmd/audit_issue_dependencies -restore dependency-backup.json > dependency-restore.json
```

Restoration requires backup schema version 1, the same database name and an
exact match between current relation rows and the backup's normalized set. It
inserts only missing original rows in one transaction. A stale or different
graph is rejected, so later edits are never overwritten by this command. A
database restored under a different name or independently modified after
normalization needs an explicitly reviewed recovery plan/full database backup.
Restoring duplicate rows means migration 466 cannot be reapplied until those
duplicates are normalized again.

Full Stage-2 down migrations remove the added indexes but deliberately retain
`issue_dependency_audit` and all historical relation rows. Reapplying 463 is
idempotent and retains the audit data. Workspace deletion remains the explicit
owner-level cleanup path. A rollback after future dependency execution has been
enabled must also stop/drain dependent execution; retaining data alone cannot
make an older dispatcher enforce prerequisites.
