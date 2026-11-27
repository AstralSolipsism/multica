# Organizing skills: packages, folders and migration

Use this when a task brings several skills from one repository into the
workspace (`multica skill package`), manages the workspace's skill folders
(`multica skill folder`), or copies a folder tree and package metadata to
another workspace. Importing one skill and editing skill content are in
[skill-import.md](skill-import.md).

- [Repository skill packages](#repository-skill-packages)
- [Managing skill folders](#managing-skill-folders)
- [Copying skill organization between workspaces](#copying-skill-organization-between-workspaces)

## Repository skill packages

For multiple skills in a repository, use `multica skill package`. It accepts
HTTPS GitHub repository or `tree/<ref>/<directory>` URLs and two-component
`https://skills.sh/owner/repo` URLs. The runtime needs a CLI version containing
these commands, delivered through the existing Labrastro release channel;
updating this document or the server alone does not upgrade an installed CLI.

```bash
multica skill package import <url> --dry-run --output json
multica skill package import <url> --output json
multica skill package import <url> --skill skills/one --skill skills/two --on-conflict rename --output json
multica skill package import <url> --all --output json
multica skill package list --output json
multica skill package get <package-id> --output json
multica skill package rescan <package-id> --output json
multica skill package rescan <package-id> --apply --output json
multica skill package rescan <package-id> --apply --skill skills/new --output json
```

Import uses `/api/skill-packages/preview` and `/api/skill-packages/apply`;
rescan uses `/api/skill-packages/{package-id}/rescan`. Requests use the current
workspace regardless of the CLI's working directory. `--dry-run` and rescan
without `--apply` only preview, with no workspace writes. List/get show the
last applied package metadata, not a live source scan.
Preview stdout shows server defaults; stderr reminds you that selection/conflict
flags do not change this read-only response. Unknown `--skill` paths are rejected
against the preview before any apply request, with available paths in the error.

Without selectors, import follows the server's manifest defaults. `--skill`
is a repository-relative skill directory, repeatable, and mutually exclusive
with `--all`; use `--skill ''` for a repository-root candidate. Package conflict
strategies are `skip` (default), `rename`, and `overwrite`. `can_write` governs
the existing target; false does not prohibit rename into an independent skill.
Same-source skills already in another package must first be detached with
`multica skill folder detach-skill <skill>` (or on the Skills page).

Rescan uses the saved URL/ref. Pass `--url <tree-url>` to preview a branch/tag
change within the same repository and subdirectory; the URL is also sent when
applying with `--apply`. Default `--apply` updates only changed imported
skills; new or detached candidates require `--skill` or `--all`. Explicit
selectors replace the default selection, so include changed paths too when
selecting new ones. Disappeared source paths are retained. Reimporting an
existing package follows these same rescan defaults.

Read all per-item statuses, reasons, diagnostics and retryable flags, including
unselected candidates. Partial failures print the complete JSON report before a
nonzero exit, including in table mode; successful items remain applied. JSON stdout stays a single
document, with warnings on stderr. Same-name candidates can fail the first apply
even with rename. For these failures or a stale preview, preview again, inspect
the results, then select remaining items; never blindly replay a write. The server's
work limit remains 45 seconds. The CLI uses a separate budget of at least 60
seconds for both the HTTP client and request context, honoring larger
`MULTICA_HTTP_TIMEOUT` settings so the server can return its timeout report.
Malformed responses leave the result
indeterminate and must not be treated as success.

Single-skill import/refresh can also return `diagnostics` (inside `skill` for
structured imports); table output displays these source/reference warnings.
Agent binding remains a separate operation using returned workspace skill IDs.

### Package references and removal

`get`, `rescan`, `dissolve` and `delete` accept a full UUID, a unique UUID prefix
of at least four hex characters, or a unique `owner/repo`. If a repository has
root and subdirectory packages, use `owner/repo:subdirectory` (or `owner/repo:`
for its root); ambiguous references list IDs and sources. `list` defaults to a
table with short IDs; `--full-id` shows full UUIDs. Single-object commands default
to JSON, and all commands accept `--output table|json`.

```bash
multica skill package list --full-id
multica skill package get owner/repo:skills
multica skill package rescan owner/repo --url https://github.com/owner/repo/tree/v2
multica skill package dissolve <package> --dry-run
multica skill package dissolve <package>
multica skill package delete <package> --dry-run
multica skill package delete <package> --yes
```

Both removal commands fetch and validate `delete-preview`, then submit its
`preview_id`. `--dry-run` prints the preview without writing. Dissolve removes
package metadata and managed markers but retains folders, skills and bindings;
it does not require `can_delete`. Delete permanently removes managed skills and
their bindings, retaining detached skills and their ancestor folders. If
`can_delete` is false, it prints the impact and fails without asking for input.
Otherwise it prompts on stderr with the package, skill count and binding count;
answer `y`/`yes` or pass `--yes`/`-y`. Other answers abort. Empty non-interactive
stdin fails with instructions to use `--yes`. No write is retried automatically.

## Managing skill folders

```bash
multica skill folder tree --full-id
multica skill folder list --full-id
multica skill folder get Engineering/Review
multica skill folder create --name Review --parent Engineering
multica skill folder update Engineering/Review --name Reviews
multica skill folder update Engineering/Reviews --parent Other
multica skill folder update Other/Reviews --root
multica skill folder delete Reviews
multica skill folder detach-skill <skill>
multica skill folder move-skill <skill> <another-skill> --folder Engineering
multica skill folder move-skill <skill> --root
```

Folder references (including `--parent` and `--folder`) accept full UUIDs,
unique UUID prefixes of at least four hex characters, case-sensitive paths from
the root such as `Engineering/Review`, or workspace-unique folder names. Duplicate
names report each ID and full path; use a path or full ID to disambiguate. Skill
references resolve in order: full UUID, exact unique name, unique UUID prefix.

`tree` and `list` default to tables with short IDs (`--full-id` for full UUIDs).
Tree rows mark package roots `[package]`, managed directories `[managed]`,
ordinary skills left in package folders `[detached]`, and candidates `[not imported]`.
Candidates appear in their managed directory, falling back to the package root
if that directory does not exist. Unclassified skills also show IDs. Tree JSON
keeps `folders`, `packages`, `placements`, `skills`, and `unclassified_count`;
list JSON is the `folders` array. `get` returns the folder object; its table also
shows the full path, kind, parent/package IDs and direct folder/skill counts.

All other commands default to JSON and accept `--output table|json`. Create
requires `--name`. Update requires a change; omit `--parent`/`--root` to retain
the parent, use `--root` to move to the root, or `--parent` to move elsewhere
(the two are mutually exclusive). Delete removes a custom folder and promotes
its direct folders/skills one level, preserving skill entities. A same-named
child can take the deleted folder's name; other sibling collisions roll back.

Move requires exactly one of `--folder` or `--root`; root means Unclassified.
It resolves the destination and **all** skills before writing, including full
UUIDs, and deduplicates skills in argument order. Unknown/ambiguous inputs cause
zero writes. Writes then run sequentially and stop at the first failure. Success
returns `{updated:true,folder_id:<uuid-or-null>,skill_ids:[...]}`. Failure exits
nonzero with one JSON report (even in table mode): `updated:false`, completed
`skill_ids`, and `failed` containing the failed `skill_id`, error and, for HTTP
failures, `status` and the structured server `response`. Completed moves stay
applied. On a timeout or malformed response the failed item's result is unknown;
read the tree before explicitly retrying. Detach preserves the folder while
removing the skill's package/source association and returns
`{skill_id:<uuid>,updated:true}`.

The server enforces workspace membership and existing creator/admin permissions.
Package-managed skills must be detached before moving; package internal folders
cannot be rearranged or used as custom destinations. A package root may be moved
or renamed by its importer or an admin. Successful organization writes refresh
open Skills pages through the existing `skill:updated` event.

## Copying skill organization between workspaces

Use this after skill contents have already been synchronized. It migrates the
saved folder tree, package metadata and placements onto existing target skill
IDs. It does not refresh upstream sources or change content, support files,
version history, labels, agent bindings or enabled state. Target-only objects
remain in place; missing target skills are reported as skipped.

```bash
multica skill folder tree --output json
multica skill folder export --output-file skills-organization.json
multica skill folder migrate --from-file skills-organization.json --dry-run
multica skill folder migrate --from-file skills-organization.json --apply --preview-id <reviewed-token>
```

Run export in the source workspace and migrate in the target workspace. Human
credentials with access to both can instead use `--from-workspace <source-uuid>`
and `--workspace-id <target-uuid>` on migrate. The same credential must authorize
both requests; task tokens cannot cross workspaces. Use separately authorized
export and file transfer when one credential cannot access both.

Migrate previews by default. Inspect `can_apply`, the complete `conflicts`,
`skipped` placements, target-only counts and each move's `from_path`/`to_path`.
Any conflict blocks the entire apply. `--apply` without `--preview-id` makes a
fresh preview and applies only if it has no conflicts. A reviewed token requires
`--from-file`, expires after 15 minutes and becomes stale if state changes.
After applying, read `folder tree` and preview again: an unchanged repeat apply
returns `changed:false`. A failed write is never automatically retried; after a
timeout or server error, preview again and inspect the state before applying.
