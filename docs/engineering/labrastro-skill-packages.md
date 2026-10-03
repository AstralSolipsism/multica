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
Manifest `skills` lists or directory values select defaults. Missing manifest
selects all; invalid manifest selects none and reports `manifest_invalid`.
Ordinary paths win over same-name dot-directory mirrors. Other duplicates
remain visible. Failed candidates are unselected and carry diagnostics.

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
apply. Source directory renames are removal plus new candidate; frontmatter
name changes preserve skill ID and fail that item if the new name collides.

Same-source adoption preserves ID, creator, config outside `origin`, labels
and agent bindings. Legacy skills.sh URLs without `origin.path` are resolved
only when their source URL slug identifies one discovered path/frontmatter
match. Ambiguous discovery is not adopted by guessing from the local name.
A skill already placed in another package must first be detached.

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
| `filtered_reference` | Directory, symlink/submodule, binary or license asset skipped. A nonregular primary SKILL.md fails import. |
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

Fork migrations are `9001`–`9008`. `9001` creates the three tables; each later
file creates one concurrent index and has a paired down migration. The fork
migrator registration provides interrupted-index repair. This range reduces
near-term collisions; future upstream syncs must still check numeric prefixes.

Upstream touchpoints (all remaining logic/queries/tests are fork files):

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
| `server/pkg/db/generated/models.go`, `labrastro_skill_package.sql.go` | sqlc output: three models and fork queries; no upstream skill columns |

Folder mutations have no WebSocket events. Existing skill created/updated/
deleted events remain. UI mutations invalidate workspace-specific skill/tree/
package queries and refresh on window focus. Binding remains explicit use of
the existing agent-skill endpoints and must respect caller-filtered skills.

## Rollback

Prefer reverting feature code and keeping the three new tables. Imported
skills remain ordinary, self-contained skill/file records readable by older
servers and daemons. Code rollback cannot restore overwritten contents;
export/backup affected skills before applying if restoration is required.
Down migrations drop package organization data and are for isolated tests or
an explicitly planned cleanup, not routine rollback. No release, deployment,
upstream PR, or import into a real workspace is part of OL-103.
