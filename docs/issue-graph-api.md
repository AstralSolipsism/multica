# Complete issue graph API (OL-40)

This API and headless data layer implement the OL-38 graph contract on top of
upstream's native issue blockers for the shared Issue surface.

## Blocker source

The graph reads `effective_issue_blocker`: the manual `issue_blocker` rows
and the same-parent stage order, exactly the edges that gate execution. The
fork's informational `issue_dependency` relations were retired by the
v0.13.0 upgrade (OL-1517): migration
`9079_labrastro_migrate_issue_dependency_to_blocker` turns every historical
blocking edge into a manual blocker, and the table, its rows and its audit
log stay in place as retired data. An edge upstream's graph rules refuse (a
cycle through the same-parent stage order, or an ancestor linked to a
descendant) is left behind and reported with `RAISE NOTICE`.

Blockers are never inherited from an ancestor: parentage only adds context
nodes. Regression coverage is `TestIssueGraph*` in the handler and service
packages, `TestLabrastroPrivateProjectBlockersAndGraph` for hidden blockers,
parents and revoked members, and `TestIssueGraphRouteRefusesGuestsAndHidesPrivateProjects`
through the production router. No real agent CLI is required or permitted by
the default tests.

## Request and authorization

`GET /api/workspaces/{workspaceId}/issues/graph`

| Query parameter | Meaning |
| --- | --- |
| `query` | URL-encoded JSON `IssueTableQuerySpec`; scope is `workspace` (default) or `project`. Existing filter semantics apply, including explicit empty selections. Sort is ignored. |
| `project_id` | Shortcut for project scope; conflicts with a different query scope project are rejected. |
| `focus_issue_id` | A workspace issue UUID. Select just this issue and its transitive prerequisite/ancestor context. An issue excluded by the filters or project scope is returned with role `context`. |

An omitted query returns the entire authorized workspace, including tasks with
no project, dates or assignee. Project/filter matches form the subject set.
All ancestors and recursive blockers are then added to a fixed point;
unrelated descendants are not added. No list pages or Gantt windows are used.
There is no node-count limit, cursor, `limit` or `scheduled` parameter. The
JSON query limit is 1 MiB; transport/proxy URL limits also apply.

Membership, project/focus scope, matched IDs, status catalog, blocker
relations, compact details and active task counts use one read-only
REPEATABLE READ transaction. Membership is rechecked inside that transaction.
The request workspace must match its authenticated transport scope, including
task credential binding. A failed transaction never emits a success.

Access follows the workspace routes' default-deny order:

- The membership middleware answers first. A workspace member continues. A
  guest is refused with 403, because the graph route is not in the guest
  allowlist (`middleware/guest.go`), whatever projects that guest may read.
- For a member, the graph is narrowed by private-project access. An issue in a
  private project the member is not in is hidden, and so are its project, its
  blockers and its parent: `has_restricted_context`, `has_restricted_parent`
  and `dependency_summary` carry only the boolean markers below.
- A hidden project or focus issue answers 404, byte-identical to a missing
  one.

## Response and projection

The checked-in `packages/core/api/testdata/issue-graph.json` is a real handler
response captured from the synthetic OL-38 14-node fixture: cross-project
edges in both aggregate directions, an unprojected prerequisite and an undated
issue, with no production data. Regenerate it after any change to the server's
graph; the frontend stage of an upgrade does so together with its expectations.
`server/internal/handler/testdata/issue-graph/reference.json` preserves the
logical source fixture; integration tests map its logical IDs to fixture UUIDs.

The version-1 envelope includes `snapshot_id`, `captured_at`, `complete: true`,
`scope`, `matched_count`, `context_count`, `nodes`, `edges` and
`has_restricted_context`. Additive fields are `topology_id`, `projects` and
`focus_issue_id`; nodes also include `priority`, `has_restricted_parent` and
`dependency_summary`. The TypeScript schema converts snake_case to camelCase.

| Field / rule | Consumer contract |
| --- | --- |
| `snapshotId` | HMAC content identity, including opaque dependency versions. Stable when only collection time changes. It is not a database cursor or authorization token. |
| `topologyId` | Identity of node membership/roles, parent/project/stage and direct edges. Status/title/run-only updates preserve it; use it to avoid unnecessary layout work. |
| `capturedAt` | Transaction timestamp; all run summaries use the same value. |
| `role` | `match` contributes to the subject count; `context` explains prerequisites or ancestry. |
| `parentIssueId` / `projectId` / `stage` | Hierarchy, project and stage grouping. Null has its ordinary unassigned meaning unless `hasRestrictedParent` is true. |
| `edges` | Every effective `blocked_by` edge, prerequisite → dependent. `sourceEdgeId` is `manual:<issue>:<blocker>` for a stored `issue_blocker` row and `stage:<issue>:<blocker>` for same-parent stage order; a stored edge replaces that pair's stage edge. No expanded descendant execution edge set is transferred. |
| `dependencySummary` | The node's own unfinished blockers, manual and stage alike: visible count, restricted blocker boolean and an opaque version of the blocker set. Only each blocker's current effective `done` or `cancelled` category satisfies it. |
| `runSummary` | Counts actual queue rows in queued/dispatched/running/waiting_local_directory states. Zero is an observed empty active set, not a guess from Issue status. |
| restricted markers | Only booleans are returned. Hidden node/parent/source-edge IDs, titles and counts are omitted. Server-side satisfaction still includes hidden blockers. |

`projectIssueGraph(graph, representatives)` groups visible node IDs under
display representatives and merges directed edges while retaining all real
source-edge IDs. It separately counts internal edges. Task-line collapse
can produce both A → B and B → A; those display arrows do not imply a task
dependency cycle. Explain the original edges, never the aggregate IDs: a
`manual:` source edge is a stored blocker, a `stage:` source edge is
same-parent stage order, and there is no separate dependency detail endpoint.

## DAG stage ordering

The shared Web/Desktop layout uses ascending stage numbers **within the same
parent issue** as display order, whether or not edges are stored. Stages on
unrelated task lines or unparented issues are not compared. Unstaged issues
and same-stage siblings remain unconstrained unless a blocker orders them.

Upstream gates execution on that stage order and reports it as `stage:` edges
in the graph; parentage alone creates no edge. Stage progression is shown in
stage headers. Folded issues use their own stage, never a child's stage. If
stage ordering would create a cycle through manual blockers (including
cross-line paths), conflicting stage boundaries are omitted; stored blockers
retain their direction. A stage edit changes `topologyId` and relayouts the
graph; status/run-only updates keep its positions.

## Grouped Web/Desktop canvas

The shared canvas uses React Flow with ELK and has two levels. The overview
shows one card per task line, standalone task, and the independent group;
cross-line dependencies paint as shared orthogonal buses. Double-clicking a
line card (or the toolbar's **Enter task line**) opens the second level: that
line's task graph with nested sub-line frames, stage columns where the layout
keeps them dependency-compatible, and dashed side cards compressing external
dependencies. Only left-to-right layout exists.

The current level (`dagLineId`), the deliberate overview return
(`dagOverviewPinned`), and one viewport per level (`dagViewports`) persist per
user; none of them are part of saved view definitions. Saved views carry
`dagShowCompleted` and `dagShowSatisfiedDependencies` as first-open defaults.
Legacy fold (`dagExpandedIds`, `dagIndependentExpanded`, `dagCollapsedIds`),
direction and single-viewport preferences are ignored on read.

Unparented issues without visible relations and
without unknown/restricted relationship information form a separate
**Independent issues** card. It uses the same canvas and opens into a compact
grid as its own level. A dependency-chain endpoint
or an unordered child of a parent is not an independent root merely because
it has no outgoing edge. Missing relationships do not authorize execution.

Fully staged siblings receive bounded stage regions with visible separators
and header-level progression. Mixed staged/unstaged siblings keep individual
stage badges and layout preferences without assigning a stage to an unstaged
issue. Conflicting stage preferences yield to dependency order. All visible
task arrows retain real source edges.

Cross-line edges are always included. On the overview they bundle per card
pair and show the dependency count; inside a line they end at the dashed
external side cards. Shared bus intervals paint once with the most urgent
traversing state; branch points carry a dot. A card-to-card arrow does not
mean that every member of one line depends on every member of the other.

Each level lays out independently: the overview packs flat cards, a line nests
its sub-line frames. One worker channel per scene class (overview / line /
focus) with a content-keyed LRU per class; opened lines cache independently.
ELK runs in a child worker through its supported API. A layout that exceeds
the 3s deadline is terminated and re-run as bounded packing; the canvas labels
that degraded result and offers a manual re-layout. Replacing a worker
invalidates its outstanding response. Failure is explicit and retryable; the
canvas does not substitute straight or guessed dependency lines. Selection,
title, status and run refreshes do not relayout an unchanged topology.

Single-click selects a card or task; the toolbar's selection zone keeps the
OL-182 actions (open detail, highlight prerequisites/dependents, edit
prerequisites, assign), and line cards additionally offer **Enter task line**.
**Focus issue group** remains available on a selected member, recentering its
innermost sub-line frame. Double-click follows the level: line cards enter,
tasks open the detail. Returning to the overview restores its viewport and
selects the line just left; each level remembers its own viewport. Ordinary
scrolling pans the canvas. Dragging stays inside an outer content extent so
routes between cards remain traversable. Navigation, layout changes and
resizes keep at least one card or frame header in view when content exists.
Recovery translates to the nearest content without changing zoom. Bounds use
actual cards and frame headers, not large empty frame backgrounds.

The former DAG project/flat grouping chooser is replaced by this task-line
model. Older shared-view grouping values continue to round-trip at the API
boundary; they do not restore the former flat canvas.

## Shared frontend integration

```ts
import { useQuery } from "@tanstack/react-query";
import { issueGraphOptions, reconcileIssueGraphDetail } from "@multica/core/issues";

const result = useQuery(issueGraphOptions(workspaceId, surfaceQuery, focusIssueId));
// When a separately requested detail arrives:
// reconcileIssueGraphDetail(queryClient, workspaceId, currentGraph,
//   snapshotIdAtDetailRequest, detail);
```

The options canonicalize set-like filters, preserve empty predicates, bind the
workspace/scope/filters/focus in the query key and pass cancellation to fetch.
They never use another scope's data as a placeholder. Server graphs stay in
React Query; local folding/selection/layout state can be stored separately.

The shared Issue surface distinguishes these states:

- No complete graph yet: loading/unavailable, not a complete empty graph.
- Successful graph with zero matches: an actual empty subject set; context can
  still exist for an explicitly located filtered issue.
- `context` nodes: filtered out of the subject set, loaded for explanation.
- Restricted markers: access is missing, not merely filtering or loading.
- Null/malformed run or dependency summary: unknown. `issueGraphReadiness`
  returns `unknown`, `blocked` or `ready` for the prerequisite summary only;
  it is not a dispatch authorization decision.
- Refresh failure: the cache may retain the previous snapshot. Clearly mark
  that snapshot stale and offer retry; never present it as current. Hide prior
  graph data on access loss (403/404). Unsupported old servers (404/405) and
  unverified dependency data (422) are unavailable, with no list fallback.

`reconcileIssueGraphDetail` compares workspace, graph membership, revision and
the snapshot ID recorded when the detail request started. A mismatch
invalidates the graph and reports `stale`/`outside_snapshot`; it never changes
nodes or edges using detail data. The UI must pass the **current** graph at
detail completion, not a captured stale graph object.

Existing issue updates (including blocker edits), creation,
deletion, label/property/metadata edits, parent/project/status changes,
catalog changes and task lifecycle events invalidate the graph. Generic
comment/attachment revisions do too. Reconnect recovers all issue query
prefixes. Streaming task messages do not refetch the graph for every chunk.
Run-only refreshes preserve `topologyId`. Local committed issue mutations use
the same cache coordinator; graph snapshots are not optimistically patched.

Use `invalidateIssueQueries(queryClient, workspaceId, "graph")` for graph-only
refreshes, or omit the last argument for the whole workspace's issue queries.
It cancels in-flight graph reads, waits for cancellation, then invalidates;
inactive graphs refetch on their next mount. This includes first loads:
TanStack's plain `invalidateQueries` can reuse an initial request without data,
letting its pre-event snapshot clear the invalidation under infinite freshness.
The shared helper also handles workspace-wide reconnect/catalog/prefix changes;
ordinary list/detail request cancellation keeps its existing behavior.

## Errors and verification

Malformed/unsupported queries return 400. A guest is refused with 403 before
the handler runs. Inaccessible workspace/project/focus returns 404 after
authentication/membership routing. A blocker endpoint outside the workspace's
issues is refused with 422 `dependency_data_unverified` and no graph is
returned. Database/commit failure returns 500 `graph_query_failed`; an
exhausted 8-second query deadline returns 504 `graph_query_timeout`. Successful
responses are `private, no-store`. Schema parsing rejects incomplete or
structurally malformed topology as a whole, tolerates additive fields and
degrades only optional summaries to unknown. The graph is read-only: blockers
gate execution through upstream's `blockers_done` system wakeup, and the
summaries here only report that state.

The opaque `dependency_version` covers the node's own blocker set. Issue
titles, statuses, revisions, the status catalog and a blocker's completion do
not change it; those changes still refresh the graph display. Blockers are
edited with upstream's `--blocked-by`, `--remove-blocked-by` and `--blocked`
flags on `multica issue`, never through the graph.

Backend regression suites are `TestIssueGraph*` and the shared Issue Table
filter tests. Client tests cover the API boundary, query
cancellation/detail races, collapse provenance and actual realtime wiring.
Regenerate the mock by running `TestIssueGraphReferenceCompleteAndProjectContext`
with `ISSUE_GRAPH_MOCK_PATH` set to the desired path (relative to the handler
package when using `go test`).

The opt-in `TestIssueGraphScale` reproduces the four OL-38 shapes at 100, 500
and 1000 nodes, then dense 5000/10000-node probes. Set
`ISSUE_GRAPH_BENCHMARK=1` and optionally `ISSUE_GRAPH_BENCHMARK_PATH` when
running it against a migrated isolated database. Each sample records one
first request and 30 subsequent requests, SELECT count, p95, raw durations,
uncompressed JSON bytes and maximum `TotalAlloc` delta with GC before each
request. Timing covers URL membership middleware/handler/SQL/JSON encoding,
excluding authentication, fixture setup, response decoding, network and
browser rendering. Total allocation is a
conservative per-request allocation measure, not process RSS or DB memory.
These test sizes are measurements, not product limits.
