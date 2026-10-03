# Skill packages: OL-103 server contract

OL-103 implements the server portion of OL-102 against fork baseline
`803cfcf18a7db98ee45e7ac10367b12a4c773711`. OL-104 owns the shared web/desktop
flows; OL-105 owns the CLI. This contract does not install plugins, runtimes,
dependencies, hooks, commands, or executable bits. Existing skill-local text
support files, including scripts and `agents/openai.yaml`, remain supported.

## Request and response contract

Use the existing authenticated API client and `X-Workspace-ID`. All IDs below
are workspace-scoped UUIDs. Members may read the tree, import packages and
manage custom folders. Package importer or owner/admin permission is needed
for package mutations. Skill creator or owner/admin permission is separately
required to adopt, update, move, detach, or delete a skill. Overwriting a skill
from a different source remains creator-only, including for administrators.
All 14 new routes reject external-conversation tokens with HTTP 403.

The schemas and inferred types are in
`packages/core/api/labrastro-skill-schemas.ts`, re-exported by
`@multica/core/api/schemas`. Consumers must use `parseWithFallback` with `null`
for malformed package/tree/write responses and display an indeterminate
result, not claim success or automatically repeat a write. Unknown candidate
states cannot be selected; unknown item statuses make the result unsuccessful.

### Preview and apply

`POST /api/skill-packages/preview`:

```json
{"url":"https://github.com/addyosmani/agent-skills"}
```

Accepted sources: HTTPS GitHub repository or `tree/<ref>/<directory>` URLs,
and two-component `https://skills.sh/owner/repo` URLs. No credentials, query,
fragment, or blob URL. Ref names containing slashes use the existing GitHub
ref resolver. The preview's canonical URL includes the resolved ref.

Example response (IDs, token and digest abbreviated):

```json
{
  "preview_id":"signed-opaque-token",
  "source":{
    "url":"https://github.com/addyosmani/agent-skills/tree/main",
    "owner_repo":"addyosmani/agent-skills",
    "subdirectory":"",
    "ref":"main",
    "revision":"request-local-commit-sha"
  },
  "candidates":[{
    "path":"skills/shipping-and-launch",
    "name":"shipping-and-launch",
    "description":"...",
    "default_selected":true,
    "state":"new",
    "can_write":true,
    "digest":"sha256",
    "file_count":4,
    "bytes":12345,
    "shared_files":["_shared/references/definition-of-done.md"],
    "diagnostics":[]
  }],
  "diagnostics":[]
}
```

`file_count` counts supporting files; `bytes` includes primary content and
supporting files. Both reflect final rewritten content. `shared_files` lists
materialized `_shared/` output paths. A repository-root candidate has `path:""`.
There are no content bodies in the preview. `skill_id` and `conflict` appear
when relevant. Candidate states: `new`, `adoptable`, `changed`, `unchanged`,
`removed`, `conflict`, `failed`. A common-prefix change that requires moving
an imported skill also marks it `changed`; the same skill permission gate
applies to that change.

Preview is strictly read-only, including package candidates and timestamps.
Manifest `skills` lists or directory values select defaults. A missing manifest
or valid manifest object without the optional `skills` key selects all discovered
candidates. An explicit empty list selects none. Malformed JSON, a non-object
manifest, a `skills` value other than a string/list of strings (including `null`
or null list entries), or paths outside the repository select none and report
`manifest_invalid`.
Ordinary paths win over same-name dot-directory mirrors. Other duplicates
remain visible. Failed candidates are unselected and carry diagnostics.

`can_write` describes the existing target operation, not whether rename may
create a separate skill. For `adoptable`/`changed`/`unchanged`, it means the caller
is the skill creator or an administrator. For `name_conflict`, it means the
caller is the conflicting skill's creator **and** that skill is not already in
a package, so overwrite is allowed. Rename does not require `can_write:true`.
For a new candidate it is true; failed, removed, ambiguous-source and
already-packaged candidates have it false. Apply always rechecks permissions.

`POST /api/skill-packages/apply`:

```json
{
  "url":"https://github.com/addyosmani/agent-skills/tree/main",
  "preview_id":"signed-opaque-token",
  "skills":["skills/shipping-and-launch"],
  "on_conflict":"skip"
}
```

`skills` and `all:true` are mutually exclusive. Omitted `skills` uses preview
defaults; `skills:[]` explicitly selects nothing. `all:true` selects every
candidate, including failed candidates so their failures enter the report.
`on_conflict` is `skip` (default), `rename`, or `overwrite`. Source identity and
ownership come from the server; client IDs, contents or permission claims are
not accepted. Unknown request fields are rejected.

```json
{
  "package":{
    "id":"package-uuid", "workspace_id":"workspace-uuid",
    "owner_repo":"addyosmani/agent-skills", "subdirectory":"",
    "source_url":"https://github.com/addyosmani/agent-skills/tree/main",
    "ref":"main", "root_folder_id":"folder-uuid", "created_by":"user-uuid",
    "revision":1,
    "candidates":[{"path":"skills/shipping-and-launch","name":"shipping-and-launch","description":"...","digest":"sha256"}]
  },
  "results":[{
    "path":"skills/shipping-and-launch", "status":"created",
    "skill_id":"skill-uuid", "retryable":false, "diagnostics":[]
  }],
  "failed":false,
  "diagnostics":[]
}
```

Results cover all candidates, not just the selected set. Item statuses:
`created`, `adopted`, `updated`, `unchanged`, `skipped`, `retained`, `failed`.
Items may include `code` and `reason`. `failed:true` means at least one item
failed; the HTTP status is still 200. CLI must print the entire report before
returning nonzero. `skipped/not_selected` is not a failure. Clients must show
candidate failure diagnostics even when those candidates were not selected.

The package metadata transaction commits before item transactions. Each item
commits content, support files, managed folders and placement together.
Failure leaves that item's prior contents intact; other items remain committed.
An apply with selected items can therefore leave an empty package if all fail.
An empty selection on a new source creates neither package nor folders.

Tokens expire after 15 minutes and bind caller, workspace, resolved source
commit, candidate summaries, permissions and workspace skill/tree state.
Apply rescans before writing. A changed source/target, role change or expired
token returns 409 `preview_stale`. Conservative invalidation also catches an
unrelated skill/tree mutation in the same workspace. Concurrent writes during
an item are rechecked under locks, including its content and placement.
Never replay an old token: preview again, inspect results, and select the
remaining items. There is no background continuation.

Before any writes, an interrupted candidate scan returns 504
`source_timeout` (deadline or request cancellation), including when the last
candidate download fails. A disconnected client may not receive the response.
With a valid, unexpired token, a fingerprint mismatch accompanied by retryable
candidate download failures returns 503 `source_unavailable`: the server could
not complete revalidation and cannot infer a source/permission change from that
failure. Successful scans still detect genuine source, permission and target
changes as 409. Invalid/expired tokens remain 409 even during a source outage.
These pre-write failures leave skills, files, folders, placements and package
metadata untouched.

A matching preview that already contained failed candidates can still apply:
selected failures enter the per-item report and other items may succeed. Once
the package metadata transaction has committed, timeout handling remains in
the item loop and returns the complete HTTP 200 report with `failed:true`;
already committed successes remain saved. Neither error path retries writes.

### Existing packages and rescans

`GET /api/skill-packages` returns `{"packages":[<package>]}`;
`GET /api/skill-packages/{packageId}` returns one package. Candidates are the
last applied path/name/description/digest summary, not a live remote inventory.
Combine it with placements to show candidates that have not been imported.

`POST /api/skill-packages/{packageId}/rescan` with `{}` returns a preview using
the saved URL/ref. To apply, repeat with `{"apply":true,"preview_id":"..."}`.
The same `skills`, `all`, and `on_conflict` fields apply. A URL override may
change ref but not owner/repository/subdirectory; preview displays the proposed
source beside the currently saved package. Apply persists the new ref. Commit
SHAs are only transient validation data, never saved as a long-term version.

Reimporting the same normalized owner/repository/subdirectory finds this
package, regardless of URL spelling or ref. Default rescan selection is only
changed imported items. New or detached candidates require explicit selection.
Removed source paths are `removed` in preview and `retained/source_removed` in
apply. Source directory renames are removal plus new candidate; the new candidate
may be imported with rename while the old skill remains in place. A same-name
skill alone is a `name_conflict`, even if it belongs to another package or an
old source path in this package. Rename creates a separate skill; overwrite
cannot transfer a packaged target.

Local display-name changes, including suffixes assigned by conflict rename,
do not make an imported candidate `changed`. Content/support-file and layout
changes still do. Content updates and same-source readoption retain that local
name while the source name is unchanged. To detect an upstream rename, apply compares the new source name
with the frontmatter (or inferred directory/repository name) of the skill's
persisted `SKILL.md`. That content only advances after a successful item commit;
the package's candidate summary can advance even when an item is deselected or
fails. Thus a skipped/failed upstream rename is retried on the next rescan.
Upstream name changes preserve skill ID and fail that item if the new name
collides. Local content edits remain unprotected by rescan, as before.

Same-source adoption preserves ID, creator, config outside `origin`, labels
and agent bindings. Legacy skills.sh URLs without `origin.path` are resolved
only when their source URL slug identifies one discovered path/frontmatter
match. Ambiguous discovery is not adopted by guessing from the local name.
A same-source skill already placed in another package must first be detached;
its `already_packaged` conflict is unselected by default, like `ambiguous_source`.

### Tree and folder operations

`GET /api/skill-folders` returns:

```json
{
  "folders":[{
    "id":"folder-uuid", "workspace_id":"workspace-uuid",
    "parent_id":null, "name":"addyosmani/agent-skills",
    "package_id":"package-uuid", "package_path":"",
    "created_at":"2026-10-03T00:00:00Z", "updated_at":"2026-10-03T00:00:00Z"
  }],
  "placements":[{
    "workspace_id":"workspace-uuid", "skill_id":"skill-uuid",
    "folder_id":"folder-uuid", "package_id":"package-uuid",
    "source_path":"skills/shipping-and-launch"
  }],
  "packages":[]
}
```

Folders use adjacency via nullable `parent_id`. Null `package_id/package_path`
denotes a custom folder. Null `package_id/source_path` denotes an ordinary
placement, including a detached skill. No placement means uncategorized.
Missing/deleted skills are excluded by joins and stale placements are cleaned
on the next mutation. Sort folders before skills, each by name, on the client.

| Route | Body | Result / behavior |
|---|---|---|
| POST `/api/skill-folders` | `{"name":"Engineering","parent_id":""}` | 201 folder; empty/omitted parent is root |
| PATCH `/api/skill-folders/{id}` | `{"name":"New name","parent_id":"folder-uuid"}` | 200 folder; omit either field to retain it; `parent_id:""` moves to root |
| DELETE `/api/skill-folders/{id}` | none | `{"deleted":true}`; promote direct contents one level; sibling name collision rejects atomically |
| PUT `/api/skill-placements/{skillId}` | `{"folder_id":"folder-uuid"}` | `{"updated":true}`; empty folder removes placement |
| POST `/api/skill-placements/{skillId}/detach` | none | `{"updated":true}`; preserve folder, remove package/source association |

Names are 1–255 UTF-8 bytes without surrounding whitespace, NUL or line breaks.
Package roots default to `owner/repo`; an existing sibling causes a numeric
suffix. Roots may be renamed or moved into custom folders. Internal managed
folders cannot be rearranged or used as destinations for custom content.
Their paths strip the common parent prefix of all discovered candidates.
Updated placements prune empty managed folders, preserving any detached skills.
All tree mutation transactions prevent cycles and enforce workspace scope.

### Dissolve and delete

`GET /api/skill-packages/{id}/delete-preview` returns
`{preview_id,skill_ids,affected_agents,can_delete}`. Each affected agent row is
`{id,name,skill_id,skill_name}`; an agent with multiple affected bindings has
multiple rows. The token also guards dissolution.

`POST /api/skill-packages/{id}/dissolve` with `{"preview_id":"..."}` removes
package metadata and managed markers, retaining folders, skills and bindings.
It returns `{"deleted":false,"dissolved":true,"skill_count":2}`.

`DELETE /api/skill-packages/{id}` with the same body deletes only currently
package-bound skills, their files/labels/bindings, package metadata, and empty
managed folders. Detached ordinary skills and their ancestor folders survive.
It returns `{"deleted":true,"dissolved":false,"skill_count":2}`. Any skill
permission failure rejects the entire operation before deletion. Both actions
validate the affected set and run atomically. Workspace deletion separately
cleans all three tables and excludes concurrent package writes with a workspace
row lock; no new foreign keys or cascades are introduced.

## Diagnostics and errors

Diagnostics use `{code,path?,target?,message,retryable}`. Old single-skill import
and refresh retain their existing response shape and add optional `diagnostics`
on the returned skill (inside `skill` for structured import results). HTTP fetch
errors retain `error` and add `code`, `diagnostics`, `retryable`.

| Code | Meaning and recovery |
|---|---|
| `tree_incomplete` | Package scan fails on truncation; use an actual smaller subtree. Legacy GitHub single import may succeed via its existing directory crawl with this warning. |
| `tree_unavailable`, `source_unavailable`, `source_timeout` | Source cannot be read; retry with a fresh preview. skills.sh tree request failure remains fatal/retryable. |
| `required_reference_unavailable`, `support_file_unavailable` | A required external reference or package support download failed; item fails, never saves a partial bundle. |
| `limit_exceeded` | 1 MiB per final file; 256 support files, 8 MiB support contents per skill; shrink source/bundle. |
| `shared_path_conflict` | `_shared` destination conflicts with existing or rewritten content; fix source before retrying. |
| `cross_skill_reference` | Other skills' SKILL.md files are not copied; reference remains unchanged. |
| `filtered_reference` | External directory, symlink/submodule, binary or license asset skipped. References between original skill files and their own directories remain unchanged without a warning. A nonregular primary SKILL.md fails import. |
| `path_outside_repository` | Reference escapes repository; unchanged. Missing example paths and remote links are also unchanged. |
| `manifest_invalid`, `dot_directory_duplicate` | Invalid manifest disables defaults; a same-name dot-directory mirror is omitted in favor of the ordinary path. |
| `preview_stale`, `source_changed` | Repreview; no blind write based on stale source, permissions or targets. |
| `name_conflict`, `ambiguous_source`, `already_packaged` | Choose rename/authorized overwrite, resolve ambiguity, or detach first. |
| `forbidden`, `permission_changed` | Check skill and package permissions separately. Default unauthorized adoption/update is skipped; explicit selection fails. |
| `folder_conflict`, `placement_conflict`, `item_failed`, `operation_failed`, `candidate_failed` | Item/transaction failed; check reason and retryable flag, then repreview. |
| `not_selected`, `source_removed` | Skipped selection or retained removed source; no failure. |

Request errors: 400 for invalid JSON/fields/UUIDs/source; 403 for denied role or
ownership; 404 for missing/cross-workspace objects; 409 for stale preview,
uniqueness/cycle/managed-tree conflicts; 413 for limits; 502/503 for source
failure; 504 for the source deadline; 500 for unexpected storage failure.
Some legacy validation errors only have `error`; do not assume a code exists.
Tree-specific codes include `folder_cycle`, `managed_folder`, `managed_skill`.
`retryable` is advice to repreview, never permission to replay a write.

## Bounded work and integration points

Each request has a 45-second context. A source shares a tree, an 8 MiB raw-file
cache, and at most eight concurrent downloads. Candidate bundles are handled
one at a time and released. Source limits are 1,024 candidates, 256 tree
requests, 32 MiB per API JSON response; raw files retain existing limits.
Trees and summaries consume additional metadata memory. The heap measurement
in the fixture test is a sampled process delta, not a hard total-memory limit.
Full scans request one recursive tree; scoped scans traverse ancestors
nonrecursively then request only the chosen subtree recursively. Shared paths
outside scope use cached nonrecursive directory lookups. Files are fetched
from the resolved commit during one request to avoid mixing branch revisions.

Apply currently scans **every candidate again**, sequentially, before validating
the preview, then writes selected items within the same 45-second server budget.
The eight-download limit is shared; it does not mean eight candidates scan in
parallel. Selecting fewer items does not reduce this initial full scan. A source
slow enough to exhaust the scan budget can time out on every attempt, including
after another successful preview. Repreview/rescan is not guaranteed to complete
on an unchanged slow connection.

A `tree/<ref>/<subdirectory>` URL actually narrows the requested tree and
candidate set, but changes the package identity (workspace + owner/repo +
subdirectory). It creates/finds a different package, not a seamless continuation
of the repository-root package; existing packaged skills cannot silently move
to it. The CLI uses at least 60 seconds per HTTP request; the web proxy setting
is tracked in the OL-104 touchpoints below. Longer client/proxy budgets allow
the server's response to arrive; they do not extend its 45-second budget.

Decision retained for this revision: no token payload change, candidate
concurrency increase, preview store or unlimited wait. A later optimization
needs separate latency/request-count measurements and tests that preserve the
shared eight-download and 8 MiB cache limits, cancellation, per-item content
limits and transaction semantics. Local fixture timings below are not a promise
that repeated attempts can import every slow source.

Fork migrations are `9001`–`9008`. `9001` creates the three tables; each later
file creates one concurrent index and has a paired down migration. The fork
migrator registration provides interrupted-index repair. This range reduces
near-term collisions; future upstream syncs must still check numeric prefixes.

### Upstream touchpoints

This is a maintenance checklist across the three fork PRs, not a claim that
the frontend/CLI files are in PR #58. Server entries describe #58; CLI entries
were checked against #59 at `b31a975f5810c78bea873b43f3c3746c25871be9`.
Frontend entries were checked against #60 at
`69939e8d78baf00f2e836d21107fd1695b21ef51`; its rework is still in progress.
Explicitly pending rows are not implemented in that frontend head.

Handwritten hooks in existing upstream files:

| File | Required change |
|---|---|
| `server/internal/handler/skill.go` | Tree mode/SHA, regular-file filtering, resolved skills.sh path/ref, shared completion calls, additive diagnostics, package hints |
| `server/internal/handler/skill_refresh.go` | Preserve diagnostics in success/failure responses |
| `server/internal/handler/skill_create.go` | Extract transaction-injected overwrite helper; existing wrapper keeps commit behavior |
| `server/internal/handler/skill_import_archive.go` | Reject sibling SKILL.md roots; nested content behavior retained |
| `server/cmd/server/router.go` | One fork route registrar call |
| `server/cmd/server/testdata/labrastro-external-routes.tsv` | 14 deny-by-default route entries |
| `server/internal/handler/workspace.go` | One transactional fork tree cleanup step |
| `packages/core/api/schemas.ts`, `packages/core/types/agent.ts` | Optional old-response diagnostics and exported new schemas |
| `packages/core/api/client.ts` | Workspace-pinned folder/package/placement methods with zod/`parseWithFallback`; `importSkill` changes from `Promise<Skill>` to `Promise<Skill \| null>`, so malformed responses remain indeterminate |
| `packages/core/package.json`, `packages/core/skills/index.ts` | Export the new `skills/package-queries` entry and query hooks |
| `packages/core/types/index.ts` | Export `SkillImportDiagnostic` for UI consumers |
| `packages/views/skills/components/skills-page.tsx` | Folder tree, subtree filtering, package-import and move dialogs, detach wiring and workspace query invalidation; the toolbar entry is here, not a separate `skill-list-toolbar.tsx` edit |
| `packages/views/skills/components/skill-list-actions.tsx` | Row/batch move and detach permissions plus batch refresh diagnostic results |
| `packages/views/skills/components/create-skill-dialog.tsx` | URL/archive import diagnostic notice view and malformed-result handling; localized sibling-skill error mapping is pending OL-104 rework |
| `packages/views/skills/components/refresh-skill-dialog.tsx` | Single-refresh success diagnostics, detail-cache update and notice dismissal |
| `packages/views/agents/components/skill-picker-list.tsx` | Tree-mode dispatch and batch-toggle props; extraction of the tree implementation to a fork file is pending OL-104 rework |
| `packages/views/agents/components/skill-add-dialog.tsx`, `skill-multi-select.tsx` (same directory) | Opt in to the tree picker and batch toggle using the caller's filtered skills |
| `packages/views/locales/index.ts`, `packages/views/i18n/resources-types.ts` | Register the `skill-packages` namespace and translation typing |
| `packages/core/skills/pack-archive.ts` | **Pending OL-104 rework:** reject parallel SKILL.md roots before local-folder packing discards them; retain nested-root handling |
| `apps/web/next.config.ts` | **Pending OL-104 rework:** `experimental.proxyTimeout: 60_000` lets the 45-second backend finish through the Next.js rewrite proxy |
| `server/cmd/multica/cmd_skill.go` | Display additive diagnostics in legacy single-import and refresh table output; JSON response shape remains unchanged |
| `server/internal/service/builtin_skills/multica-platform/references/skill-import.md` | Package CLI entry, selection/rescan defaults, complete partial-failure reports and no blind write retry |

New handwritten modules include the server `labrastro_skill_*.go` handlers and
migrator hooks, `packages/core/api/labrastro-skill-schemas.ts` (extended by #60),
`packages/core/skills/package-queries.ts`, package/folder/move dialogs and tree
models under `packages/views/skills/`, `skill-diagnostics-notice.tsx`, the five
`skill-packages.json` locale files, and
`server/cmd/multica/cmd_labrastro_skill_package.go` (registered with `init()`).
They are feature modules, not generated output. Their adjacent tests cover the
hooks above; #59 also updates `server/internal/service/builtin_skills_test.go`.

Generated sqlc output is separate from those handwritten hooks:

| Generated file | Input and purpose |
| --- | --- |
| `server/pkg/db/generated/models.go` | Three models from `server/migrations/9001_labrastro_skill_packages.up.sql`; no upstream skill columns |
| `server/pkg/db/generated/labrastro_skill_package.sql.go` | Queries/types from `server/pkg/db/queries/labrastro_skill_package.sql` |

`server/sqlc.yaml` reads the full `server/migrations/` schema and
`server/pkg/db/queries/` directory. Regenerate from the repository root with
`make sqlc` (the Makefile pins sqlc v1.31.1), then inspect the generated diff.
Indexes come from migrations 9002–9008, each with its paired down migration.
This source-error revision changes no SQL or sqlc inputs and does not regenerate
files as a substitute for handler/contract verification.

Folder mutations have no WebSocket events. Existing skill created/updated/
deleted events remain. UI mutations invalidate workspace-specific skill/tree/
package queries and refresh on window focus. Binding remains explicit use of
the existing agent-skill endpoints and must respect caller-filtered skills.

## Rollback

Normal application rollback reverts feature code and **keeps** all three
`labrastro_skill_*` tables, their migration records and the ordinary skill/file
rows. Older servers and daemons can read the completed skills. Down migrations
drop organization metadata and are reserved for isolated tests or an explicit
data-cleanup plan; dropping tables does not restore content.

Take an operation-time backup before any action that can replace content:
package `overwrite`, same-source adoption, default `rescan --apply` (including
reimport of an existing package), explicitly selected changed items,
single-skill overwrite import, and single/batch refresh from source. Default
rescan does not protect local edits. Reverting code, dissolving a package or
detaching a skill cannot undo those replacements.

**Observed rollback hazard:** OL-106 ran the old server at `803cfcf18` against
the new database. Reads included `_shared/*`, but an old-server “update from
source” removed those files and restored repository-relative links such as
`../../references/...`. Read compatibility does not imply that old refresh
preserves completion. After rollback, pause single/batch source refresh and
covering imports for completed skills, or recover their contents from backup.
There is no automatic undo.

### Backup scope and commands

Use a database backup taken before the operation; a plain SKILL.md/zip export
alone does not retain IDs, ownership, bindings, labels or package organization.
The minimum logical set is `skill` (including content/config/creator),
`skill_file` (including every `_shared/*` row), `agent_skill`,
`skill_to_label`, and all three `labrastro_skill_*` tables. Those rows refer
to workspace/user/agent identities and label definitions in `issue_label`;
restore them only with those matching records. A whole-database archive is
the recommended default because it also preserves those dependencies and
`schema_migrations`. For deployments with external uploads, retain the normal
object-store backup separately; it is outside this skill-content backup.

The following commands are an operator runbook, not authorization to touch a
connected workspace. Populate `SKILL_BACKUP_SOURCE` using a dedicated database
service/credential, and keep credentials out of shell history/logs. Pause
affected writers, record the application commit and PostgreSQL version, and
restrict archive access; a full archive also contains unrelated workspace data.

```sh
set -eu
umask 077
: "${SKILL_BACKUP_SOURCE:?set the authorized source connection/service}"
: "${SKILL_BACKUP_DIR:?set a new private backup directory}"
mkdir -p "$SKILL_BACKUP_DIR"
pg_dump --dbname="$SKILL_BACKUP_SOURCE" --format=custom --no-owner --no-acl \
  --file="$SKILL_BACKUP_DIR/before-skill-operation.dump"
pg_restore --list "$SKILL_BACKUP_DIR/before-skill-operation.dump" \
  > "$SKILL_BACKUP_DIR/archive.list"
sha256sum "$SKILL_BACKUP_DIR/before-skill-operation.dump" \
  > "$SKILL_BACKUP_DIR/archive.sha256"
```

Verify the archive list includes the seven skill/organization tables and their
data sections. A selective `pg_dump -t skill -t skill_file -t agent_skill
-t skill_to_label -t labrastro_skill_folder -t labrastro_skill_package
-t labrastro_skill_placement` is only an alternative when matching identity,
label and schema backups already exist; it does not follow those dependencies
and is not a standalone disaster-recovery backup.

### Isolated restore rehearsal

Use a newly created database in a separate local PostgreSQL cluster with the
same required extensions. Never run restore/cleanup commands against the live
workspace database. This example deliberately creates a new database without
`--clean` or `--create`; choose an unused local port and database name:

```sh
set -eu
unset PGSERVICE PGSERVICEFILE PGDATABASE PGOPTIONS
export PGHOST=127.0.0.1 PGPORT=55483 PGUSER=postgres
: "${SKILL_RESTORE_DB:?set a new isolated rehearsal database name}"
createdb --template=template0 "$SKILL_RESTORE_DB"
pg_restore --dbname="$SKILL_RESTORE_DB" --exit-on-error --single-transaction \
  --no-owner --no-acl "$SKILL_BACKUP_DIR/before-skill-operation.dump"
psql --dbname="$SKILL_RESTORE_DB" --no-psqlrc --set=ON_ERROR_STOP=1 \
  --command="SELECT count(*) FROM skill; SELECT count(*) FROM skill_file WHERE path LIKE '_shared/%'; SELECT count(*) FROM labrastro_skill_placement;"
```

Compare row counts and hashes of complete rows (including contents/config,
paths, IDs, creator, labels, bindings and candidate metadata) with the backup
snapshot. In this isolated copy, change a skill and remove its shared files,
then restore the archive into a **second fresh database** and verify exact
recovery. Run a rollback-version server on isolated ports with all production
credentials/integrations removed; verify skill reads, and reproduce the refresh
hazard only on a disposable copy. The validation record identifies what was
actually rehearsed.

Promoting restored data is a separate maintenance decision: pause writers,
assess writes since the backup, and review either whole-database replacement or
a transactionally consistent selective restore of the affected IDs and related
rows. A full restore can lose later unrelated writes; app rollback alone
cannot promise restoration. No release, deployment, upstream PR or real
workspace mutation is included in this work.
