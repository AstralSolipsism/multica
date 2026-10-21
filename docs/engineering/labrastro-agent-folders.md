# Agent folders: OL-1028 server and core contract

The agent page uses a workspace-shared custom folder tree. Squad folders are
derived from active squads and their agent members, never stored as folder
rows. Terminology and the storage decision are defined in `GLOSSARY.md` and
`docs/adr/0003-agent-folders-separate-tree-squad-folders-derived.md` (PR #157).
This change provides the server and core client; OL-1030 owns the page.

## API

Use the existing authenticated client with `X-Workspace-ID`. All IDs are UUIDs
scoped to that workspace. External-conversation tokens receive 403 for all
six routes through the production router's user-auth middleware.

`GET /api/agent-folders` returns:

```json
{
  "folders": [{
    "id": "uuid", "workspace_id": "uuid", "parent_id": null, "name": "Design",
    "created_at": "2026-10-21T00:00:00Z", "updated_at": "2026-10-21T00:00:00Z"
  }],
  "placements": [{"agent_id": "uuid", "folder_id": "uuid"}],
  "squads": [{
    "squad_id": "uuid", "name": "Game design", "avatar_url": null,
    "leader_id": "uuid", "creator_id": "uuid", "parent_id": null,
    "agent_ids": ["uuid"]
  }]
}
```

All three collections and every `agent_ids` are arrays, including when empty.
`folders` contains only custom folders. `squads` contains every unarchived
squad, including empty squads and squads with no visible members. `parent_id`
is a custom folder ID or `null` for root; a dangling squad placement reads as
root. Squad folders use the squad ID as their identity.

| Method and route | Request | Result |
| --- | --- | --- |
| POST `/api/agent-folders` | `{ "name": "Design", "parent_id": "" }` | 201 folder |
| PATCH `/api/agent-folders/{folderId}` | `{ "name": "...", "parent_id": "..." }` | 200 folder |
| DELETE `/api/agent-folders/{folderId}` | No body | 200 `{ "deleted": true }` |
| PUT `/api/agent-placements/{agentId}` | `{ "folder_id": "..." }` | 200 `{ "updated": true }` |
| PUT `/api/agent-squad-placements/{squadId}` | `{ "folder_id": "..." }` | 200 `{ "updated": true }` |

On create, omitted or empty `parent_id` means root. PATCH preserves omitted
fields; an empty `parent_id` moves to root. PUT requires `folder_id`; empty
means root and deletes the placement. Parent and destination IDs must name
custom folders in this workspace: a squad ID is not a valid destination.
Archived squads are not movable (404).

Folder names contain 1–255 UTF-8 bytes, no surrounding whitespace, and no
Unicode control characters (including tabs/newlines). Custom sibling names
are unique, case-sensitively, including at root. Squad names do not participate
in this constraint.

Errors produced by the handlers use `{ "error": "message", "code": "...", "retryable": false }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_name` / `invalid_request` | Invalid name or body |
| 403 | `forbidden` | Insufficient permission |
| 404 | `not_found` | Object absent, in another workspace, or archived squad |
| 409 | `folder_cycle` | Parent would create a cycle |
| 409 | `name_conflict` | Duplicate sibling name, including deletion promotion |
| 500 | `operation_failed` | Unexpected failure |

Server errors set `retryable: true`; clients never
automatically repeat a write. Authentication and UUID validation use the same
shared boundary helpers as skill folders, with their errors adapted to this
envelope (`invalid_request`, `unauthenticated`, `forbidden`, or `not_found`).

## Placement, visibility, and permissions

- An agent appears inside every active squad it belongs to and, independently,
  inside its custom folder when it has a placement. It appears at root only
  when it has neither an active squad nor a custom placement (方案 B).
- Squad members can be placed just like other agents. The placement endpoint
  never rejects an agent because of squad membership. Clearing the placement
  with `folder_id: ""` removes only the custom position; squad folders still
  contain the agent. These operations never modify squad membership.
- Joining, leaving, or archiving a squad does not change a custom placement.
  Archived agents are still returned; the page applies its own
  mine/all/archived filters.
- Human squad members, deleted agents, and agents outside this workspace
  never appear in `agent_ids`. Visibility matches `ListAgents`, using
  `memberAllowedToViewAgent` and the same actor handling. Both placements
  and squad members are filtered; owner/admin and agent-owner visibility
  and member allow-lists are preserved.
- Workspace owner/admin/member can read and manage custom folders. Moving
  an agent requires its owner or workspace owner/admin. Moving a squad
  folder uses `canManageSquad` (creator or workspace owner/admin).
- Deleting a folder promotes its direct child folders, agent placements,
  and squad placements to its parent. At root, placement rows are deleted.
  A sibling name conflict rolls the entire operation back, including stale
  placement cleanup. No agent or squad is deleted. The deleted folder's own
  name is available to a promoted child.

## Transactions and storage

The fork owns `labrastro_agent_folder` (adjacency list),
`labrastro_agent_placement`, and `labrastro_agent_squad_placement`. There are
no foreign keys or cascades. Custom folders and positions are shared by the
whole workspace, rather than owned by the member who created them.

Each mutation locks the workspace lifetime row `FOR KEY SHARE`, then the
workspace tree advisory lock (hash seed 9030), then the member row `FOR SHARE`.
Resource ownership checks hold the agent or squad row `FOR SHARE`. Parent
validation, cycle checks, cleanup, promotion, and writes run inside that
transaction. READ COMMITTED ensures a writer waiting on the advisory lock
sees the preceding writer's committed tree. This follows the skill tree's
lock order and avoids reusing a pre-wait SERIALIZABLE snapshot. Workspace
deletion holds the incompatible workspace lifetime lock before sweeping
all three tables, closing the no-FK insertion window.

Tree reads use one read-only REPEATABLE READ transaction for consistent
folders, membership, visibility, and positions. Dangling placements are
ignored on read and pruned on the next successful tree mutation. Squad
membership and archive writes stay in the existing upstream handlers.

Migrations:

- `9030_labrastro_agent_folders`: three tables, reversible.
- `9031_labrastro_agent_folder_id_index`: unique folder ID.
- `9032_labrastro_agent_folder_sibling_index`: unique workspace/parent/name,
  with `NULLS NOT DISTINCT` for root.
- `9033_labrastro_agent_placement_identity_index`: unique workspace/agent.
- `9034_labrastro_agent_squad_placement_identity_index`: unique workspace/squad.

Each index is a separate concurrent migration, with invalid-index recovery
registered in `server/cmd/migrate/labrastro_migrations.go`. Both migration
directions and interrupted index recovery have DB tests. Run `make sqlc`
after changing the SQL; commit `server/pkg/db/generated` with it.

## Core consumption

`packages/core/api/labrastro-agent-folder-api.ts` installs these methods through
`labrastro-api.ts`: `getAgentFolderTree`, `createAgentFolder`,
`updateAgentFolder`, `deleteAgentFolder`, `setAgentPlacement`, and
`setAgentSquadPlacement`. Every method takes `wsId` first and pins the workspace
header while clearing the slug header, even if the user changes workspace
before the request finishes.

Schemas and inferred types live in `labrastro-agent-folder-schemas.ts`, also
exported by `@multica/core/api/schemas`. Schemas transform wire snake_case into
camelCase (`parentId`, `folderId`, `squadId`, `agentIds`, etc.). Create/update
request objects use `parentId`; PUT methods take `folderId` as an argument.
Malformed responses return `null` through `parseWithFallback`, including
write results. Consumers must show an indeterminate result rather than assume
success or retry the write.

Use `agentFolderTreeOptions(wsId)` and `invalidateAgentFolderQueries(qc, wsId)`
from `@multica/core/agents/folder-queries` (also exported by `@multica/core/agents`).
The key is `["workspaces", wsId, "agent-folders"]`. Invalidate after a local
write settles, including an unreadable response. Mutations must use `retry:
false` if configuring TanStack mutations. The API layer adds no retries.

The tree invalidates on all `agent:*` and `squad:*` events. Custom folder
writes do not broadcast new events; other clients refresh on window focus
or the next query. The tree overrides the shared Infinity stale time with 0
and sets `refetchOnWindowFocus: "always"`.

## Upstream mount points

| File | Retained addition |
| --- | --- |
| `server/cmd/server/router.go` | One `RegisterLabrastroAgentFolderRoutes(r)` call |
| `server/internal/handler/workspace.go` | One transactional tree deletion step |
| `server/cmd/server/testdata/labrastro-external-routes.tsv` | Six deny entries |
| `packages/core/api/schemas.ts` | Schema exports |
| `packages/core/agents/index.ts` | Query exports |
| `packages/core/package.json` | `./agents/folder-queries` export |
| `packages/core/realtime/use-realtime-sync.ts` | Import and two prefix invalidation calls |

The API installer and migration registrations use existing fork modules.
Generated sqlc models/queries are derived output. No upstream agent or squad
write path changes, new WebSocket event, or front-end page is included. OL-1030
will append its page mount points here.

## Rollback

Remove the mounts above and the fork modules, regenerate sqlc, and deploy
without these endpoints before dropping storage. Apply the four index down
files in reverse order, then `9030_labrastro_agent_folders.down.sql`, using the
migration runner so its ledger remains correct. Export the three tables
before dropping them if positions must be restored. Dropping this tree loses
custom folders and placements but leaves every agent, squad, and membership
untouched. A fresh install and an upgrade use the same additive migrations;
no upstream data backfill is required.
