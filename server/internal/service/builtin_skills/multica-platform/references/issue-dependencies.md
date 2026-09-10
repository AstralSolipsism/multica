# Issue prerequisites and graph

## Explicit prerequisites and execution admission

`GET /api/issues/{id}/dependencies` returns direct and inherited prerequisites,
direct successors, unfinished prerequisites, a restricted-blocker flag and an
opaque `dependency_version`. A task inherits the explicit prerequisites of its
ancestors; parentage alone does not block execution. Only each prerequisite's
own current effective `done` category satisfies it. Existing status-write
permissions remain unchanged; `in_review` and `cancelled` are not satisfaction.

Register known prerequisites when creating the plan. Parentage and stages do
not substitute for explicit dependency edges. These commands accept issue keys
or full UUIDs; repeat `--blocked-by` once per prerequisite (no `--depends-on`
alias). Cross-project prerequisites are allowed within one workspace.

```bash
multica issue create --title "Checkout API" --parent MUL-32 --stage 3 \
  --project <project-uuid> --blocked-by MUL-39 --blocked-by MUL-41 --status backlog
multica issue dependency list MUL-42 --output json
multica issue dependency add MUL-42 --blocked-by MUL-40
multica issue dependency remove MUL-42 --blocked-by MUL-40
multica issue update MUL-42 --blocked-by MUL-39 --blocked-by MUL-41
multica issue update MUL-42 --clear-blocked-by
```

`create` writes the issue, parent/project/stage, prerequisites and any allowed
dispatch together. `update --blocked-by` **replaces all direct prerequisites**;
it does not append. `--clear-blocked-by` explicitly clears them and is mutually
exclusive with `--blocked-by`. Omitting both leaves prerequisites unchanged.
`dependency add/remove` read the direct set and submit an edited set. All three
update forms carry the server version from that read; a conflict exits nonzero
without automatic rereading or retrying. Read again and decide before a new edit.
Inherited prerequisites are shown separately; edit their source issue to change
them. The CLI does not decide whether a prerequisite is complete or removable.

The compound API paths are
`POST /api/issues/with-dependencies` and
`PATCH /api/issues/{id}/with-dependencies`; writes use the same dependency
admission as enqueue, claim and retry.
The CLI fails explicitly on 404/405 (unsupported/disabled API or inaccessible
issue); it never falls back to ordinary create/update. On an older CLI that
does not recognize these flags, stop and report the missing capability. Never
omit dependencies to make creation or dispatch succeed. Commands without new
dependency flags keep their original HTTP paths and behavior.

`blocked_by` is an array of UUIDs/identifiers:
omission preserves direct relations, `[]` clears them, and `null` is invalid.
PATCH replacement requires `expected_dependency_version`; a stale version
returns 409. New machine assignments with unfinished prerequisites reject the
whole mutation, even for backlog or `suppress_run`. Unassigned backlog planning
is valid. Removing unfinished constraints, reparenting away from them or
deleting tasks to remove them requires a trusted human JWT; a PAT or task
credential is not a human override. This is not a new completion policy.

Errors expose `reason_code`: `dependency_unsatisfied`, `dependency_cycle`,
`dependency_ancestor_conflict`, `dependency_version_conflict`,
`dependency_change_not_allowed`, `dependency_override_not_allowed`,
`dependency_override_stale`, `dependency_override_expired`,
`dependency_data_unverified`, or `not_found`. Missing/malformed dependency data or hidden
unfinished prerequisites must never be interpreted as ready. No automatic
dispatch along arbitrary dependency edges is added.

Unverified historical relations keep dependency GET/compound writes unavailable
until the workspace is audited. Ordinary issue operations check their affected
parent/`blocked_by` component, so unrelated historical anomalies do not block
assignment, reparenting or deletion workspace-wide. `blocks` is not interpreted
as a prerequisite. Canonical constraints still apply with compound writes off;
an affected invalid canonical reference fails closed. A successful ordinary
operation does not mean the workspace is verified.

A human may preassign a blocked issue without starting it. To intentionally start
one execution early, a human JWT client must preview the exact complete mutation
with `POST /api/issues/preview-trigger` (`mutation`, plus `issue_ids` or
`is_create`), display every blocker, and submit the returned `request_id` and
`challenge` as `dependency_override` on the compound write. The challenge expires
in five minutes; first claim expires fifteen minutes after confirmation. Never
invent or infer confirmation from a comment, a PAT, an owner, or an originator.
Agents should report `dependency_unsatisfied` and propose backlog work or ask the
human for help. They must not replay a human session or confirmation themselves.
The mutation must be a JSON object. A malformed mutation (including `null`)
returns HTTP 400 `invalid mutation payload` before any write or confirmation;
correct the request body before retrying. Batch confirmations validate the
shared `updates` object before any item is written.

The committed response includes `dispatch`: `queued`, `coalesced`, `deferred`,
or `blocked`, with `reason_code` and task/run IDs when available. Identical
confirmation retries return the same execution. Modified input, later reruns,
provider retries, Squad members/children and ordinary comments need their own
normal admission. Comment saves remain successful when dispatch is blocked;
inspect `trigger_outcomes` rather than assuming a mention ran. Batch updates use
`dependency_overrides` keyed by issue ID and retain per-item results. Missing or
malformed outcome fields mean unknown, never permission to retry a write.

CLI `--output json` preserves the server's dependency and dispatch fields, and
dependency HTTP refusals print the structured error body on stdout with guidance
on stderr. `--output table` prints readable refusal guidance on stderr only;
choose JSON when a caller needs the structured error body. Keep the streams
separate. Issue error bodies are bounded at 1 MiB (other paths retain 4 KiB).
An oversized body produces a local JSON diagnostic with `body_truncated: true`,
`http_status` and `error`, not a partial server payload. Complete diagnostics
are unavailable; do not retry the write automatically. The HTTP failure and
its nonzero exit classification are preserved.
Exit codes retain the existing contract:
409/conflict = 1, 403/permission = 3, 404 = 4, 400/422 = 5; a 405 is 1.
`issue comment add` can exit 1 **after the comment was saved** when any
`trigger_outcomes` entry is blocked. Its JSON is the saved comment, including
the comment ID and all target outcomes, even when other targets did start.
Do not repost the comment or treat a nonzero exit as proof that no write happened.

When prerequisites are ready, advance the issue using ordinary assignment and
status commands under the existing stage/Squad/automation workflow. When
`dependency_unsatisfied` is returned, stop dispatching and suggest next steps or
request human handling. `--no-start` is not an exemption for a new machine
assignment. CLI task tokens, PATs and cloud PATs never become human authority
through an owner/originator, a header, a flag, or a confirmation string. This
CLI supplies no force/override flag; the explicit human interaction belongs to
the authenticated UI/API flow above.

## Complete issue graph: Stage 3 API contract

`GET /api/workspaces/{workspaceId}/issues/graph` reads a complete compact
snapshot in one read-only REPEATABLE READ transaction. The default includes
every project and unprojected/undated issue in the workspace. `project_id`
selects a project; URL-encoded `query` accepts the shared Issue Table query
spec with workspace/project scope and filters. There is no pagination or
scheduled-only default; unsupported parameters fail instead of truncating.
`focus_issue_id` locates one visible issue and its prerequisite/ancestor
context, even when filters exclude it; an excluded focus remains context.

The response has `schema_version: 1`, opaque `snapshot_id` and `topology_id`,
`captured_at`, `complete: true`, separate `matched_count`/`context_count`,
nodes, direct edges and project titles. Edges point from prerequisite to
dependent and retain the stored `source_edge_id`. Parent fields explain
inherited prerequisites. Collapsed project arrows are display projections;
opposing project arrows are not evidence of an Issue cycle.

Each node carries its revision, current effective status category, dependency
summary/version and actual queued/dispatched/running/waiting task counts.
`in_progress` alone is not a run. Restricted prerequisites still block, but
only boolean restricted-context/blocker/parent markers are exposed; no hidden
IDs, titles or counts. Current authorization is workspace membership, matching
ordinary issue reads. Graph reads recheck it inside the snapshot. Foreign
workspace/project/focus references are not readable. Invalid dependency data
returns 422; query failures/timeouts return 500/504, never a partial success.

Missing/malformed graph data is unavailable, not an empty graph or readiness.
Unknown run/dependency summaries remain unknown. Details loaded afterward do
not patch topology; changed revisions require a graph refresh. Shared React
Query helpers own this cache and existing committed events/reconnects
invalidate it. The shared invalidation helper cancels graph reads before
refetching, including an initial request with no cached snapshot, so a late
pre-event response cannot erase a committed change's refresh signal.
There is no graph CLI command or new navigation in this stage. Use the
complete graph endpoint for topology and the dependency endpoint for decisions.

