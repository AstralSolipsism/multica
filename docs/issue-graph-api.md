# Complete issue graph API (OL-40)

This additive API and headless data layer implement the OL-38 v2 graph
contract on top of OL-39 persistence. OL-43/T6 can consume them from the
existing shared Issue surface. Rendering, navigation, layout workers and
dependency dispatch admission belong to their respective stages.

## Request and authorization

`GET /api/workspaces/{workspaceId}/issues/graph`

| Query parameter | Meaning |
| --- | --- |
| `query` | URL-encoded JSON `IssueTableQuerySpec`; scope is `workspace` (default) or `project`. Existing filter semantics apply, including explicit empty selections. Sort is ignored. |
| `project_id` | Shortcut for project scope; conflicts with a different query scope project are rejected. |
| `focus_issue_id` | A workspace issue UUID. Select just this issue and its transitive prerequisite/ancestor context. An issue excluded by the filters or project scope is returned with role `context`. |

An omitted query returns the entire authorized workspace, including tasks with
no project, dates or assignee. Project/filter matches form the subject set.
All ancestors and recursive prerequisites are then added to a fixed point;
unrelated descendants are not added. No list pages or Gantt windows are used.
There is no node-count limit, cursor, `limit` or `scheduled` parameter. The
JSON query limit is 1 MiB; transport/proxy URL limits also apply.

Membership, project/focus scope, matched IDs, status catalog, dependency
relations, compact details and active task counts use one read-only
REPEATABLE READ transaction. Membership is rechecked inside that transaction.
The request workspace must match its authenticated transport scope, including
task credential binding. Existing workspace membership is the current access
policy; there is no separate project/issue ACL in this stage. The projection
accepts a visibility policy for future finer permissions and is tested through
hidden parent/prerequisite paths. A failed transaction never emits a success.

## Response and projection

The checked-in `packages/core/api/testdata/issue-graph.json` is a real handler
response from the synthetic OL-38 14-node/7-edge fixture. It includes cross
project edges in both aggregate directions, hierarchy inheritance, an
unprojected prerequisite and an undated issue. No production data is included.
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
| `edges` | Direct `blocked_by` relations only. Stored B-depends-on-A becomes A → B. Every edge retains its real `sourceEdgeId`. No expanded descendant execution edge set is transferred. |
| `dependencySummary` | Unique unfinished direct/inherited prerequisites: visible count, restricted blocker boolean and the same opaque version as dependency detail. Only each prerequisite's current effective `done` category satisfies it. |
| `runSummary` | Counts actual queue rows in queued/dispatched/running/waiting_local_directory states. Zero is an observed empty active set, not a guess from Issue status. |
| restricted markers | Only booleans are returned. Hidden node/parent/source-edge IDs, titles and counts are omitted. Server-side satisfaction still includes hidden prerequisites. |

`projectIssueGraph(graph, representatives)` groups visible node IDs under
display representatives and merges directed edges while retaining all real
source-edge IDs. It separately counts internal edges. Project/feature collapse
can produce both A → B and B → A; those display arrows do not imply a task
dependency cycle. Edit or explain the original edges, never the aggregate IDs.
For inherited explanations, follow the node's parent chain and original
incoming edges, or request `/api/issues/{id}/dependencies` on demand.

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

Use these distinct states in T6:

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

Existing issue updates (including compound relation changes), creation,
deletion, label/property/metadata edits, parent/project/status changes,
catalog changes and task lifecycle events invalidate the graph. Generic
comment/attachment revisions do too. Reconnect recovers all issue query
prefixes. Streaming task messages do not refetch the graph for every chunk.
Run-only refreshes preserve `topologyId`. Local committed issue mutations use
the same cache coordinator; graph snapshots are not optimistically patched.

## Errors and verification

Malformed/unsupported queries return 400. Inaccessible workspace/project/focus
returns 404 after authentication/membership routing. Invalid canonical or
unverified historical dependency data fails closed with 422. Database/commit
failure returns 500 `graph_query_failed`; an exhausted 8-second query deadline
returns 504 `graph_query_timeout`. Successful responses are `private, no-store`.
Schema parsing rejects incomplete or structurally malformed topology as a
whole, tolerates additive fields and degrades only optional summaries to
unknown. Ordinary endpoints and the Stage 2 compound-write gate are unchanged.

Backend regression suites are `TestIssueGraph*`, `TestDependency*` and the
shared Issue Table filter tests. Client tests cover the API boundary, query
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
