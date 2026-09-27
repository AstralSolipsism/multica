# Issue prerequisites and graph

## Informational relations

Dependencies record planning context. They do not authorize or block assignment,
enqueue, claim, retries, comments, automation, or Squad execution. All execution
uses the upstream rules. There is no dependency override or confirmation flow.
An unfinished prerequisite can coexist with a running dependent issue.

`GET /api/issues/{id}/dependencies` returns direct and inherited prerequisites,
direct successors, unfinished prerequisites, restricted-context markers and an
opaque `dependency_version`. Only a prerequisite's own current effective
`done` category counts as satisfied in this informational projection. Parentage
alone is not a prerequisite; ancestors' explicit prerequisites are inherited.
Cross-project edges are allowed within one workspace.

```bash
multica issue create --title "Checkout API" --parent MUL-32 \
  --project <project-uuid> --blocked-by MUL-39 --status backlog
multica issue dependency list MUL-42 --output json
multica issue dependency add MUL-42 --blocked-by MUL-40
multica issue dependency remove MUL-42 --blocked-by MUL-40
multica issue update MUL-42 --blocked-by MUL-39 --blocked-by MUL-41
multica issue update MUL-42 --clear-blocked-by
```

`update --blocked-by` replaces all direct prerequisites. `--clear-blocked-by`
clears them and is mutually exclusive with `--blocked-by`. Omitting both leaves
relations unchanged. The CLI accepts issue keys or full UUIDs. Edit the source
ancestor to change inherited relations. These edits use normal issue write
permissions; machine credentials have no additional human-only restriction.

Compound create/update use `POST /api/issues/with-dependencies` and
`PATCH /api/issues/{id}/with-dependencies`. Issue fields and relation changes
commit atomically. Ordinary execution then follows upstream behavior.
`blocked_by` omission preserves direct relations, `[]` clears them, and
`null` is invalid. Replacement requires `expected_dependency_version`;
a stale version returns 409. The CLI reads this version before editing and
does not silently retry a conflict. Read again and decide before another edit.
Unsupported compound endpoints fail explicitly instead of discarding relations.

Cycle, ancestor, workspace and version validation protect graph consistency.
Invalid graph data can make graph reads or relation edits unavailable; it is not
execution admission. Historical execution-override fields are rejected. No
automatic dispatch along relation edges is added.

Use `--output json` for structured relation responses/errors. The CLI bounds
error bodies to 1 MiB, returns a nonzero exit code on failure and does not retry
writes automatically. Execution state comes from the ordinary upstream task
and trigger APIs, not from a dependency-specific dispatch result.

## Complete issue graph

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
`in_progress` alone is not a run. Restricted prerequisites remain informational;
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
The workspace and project issue views include a graph. There is no graph CLI command. Use the
complete graph endpoint for topology and the dependency endpoint for decisions.
