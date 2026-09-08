# Issue prerequisites (OL-39, DAG Stage 2)

This implements the persistence boundary frozen by OL-38 contract v2 on
baseline `aa5d5a17dc821d88dfdace7a49726df55d49dd31`. It reuses
`issue_dependency`, `issue.parent_issue_id`, projects, stages and the existing
`issuestatus` resolver.

## Semantics and ownership

When B waits for A, store exactly one canonical row:
`(issue_id=B, depends_on_issue_id=A, type=blocked_by)`. The execution arrow is
A → B. `related` is inert. Historical `blocks` rows have unverified direction;
neither the migration nor the service reverses them automatically.

The effective prerequisites of a task are the union of the direct prerequisites
on itself and every ancestor. Parentage alone is not a prerequisite. The
referenced prerequisite's **own current** effective category `done` satisfies
the relation. `in_review`, `cancelled` and unknown categories do not. Completion
does not recursively depend on the prerequisite's predecessors. Existing
status-write permissions and completion producers remain unchanged (D1).

Validation checks the complete proposed forest and graph, including completed
tasks, without a depth or list-page limit. The compressed graph has two nodes
per issue, with `gate(v) → done(v)`, `gate(parent) → gate(child)` and
`done(prerequisite) → gate(dependent)` arcs. DFS detects inherited waiting
cycles; ancestor intervals reject self and ancestor/descendant prerequisites.
The graph representation is O(V+E+H), with deterministic O(V log V) ID ordering.
Cycle diagnostics contain original issue/edge IDs, never compression nodes.

Machine callers may add constraints. Removing an unfinished direct relation,
losing inherited constraints on reparent, or deleting a prerequisite/parent so
surviving tasks lose unfinished constraints requires a trusted human JWT.
PATs, cloud PATs, task credentials and unknown identities are not human
overrides. This rule does not restrict existing status writes. Relation writes,
deletions and child detachments record before/after structure, credential kind
and actor ID (agent ID when available, otherwise user ID) in
`issue_dependency_audit` in the mutation transaction.

## Read and write boundary

| Endpoint | Contract |
| --- | --- |
| `GET /api/issues/{id}/dependencies` | Complete dependency view in a repeatable-read snapshot. |
| `POST /api/issues/with-dependencies` | Existing issue creation pipeline with atomic prerequisite persistence. |
| `PATCH /api/issues/{id}/with-dependencies` | Existing issue update pipeline with atomic prerequisite replacement. |

The response has `blocked_by`, `inherited_blocked_by`, `blocking`, `unsatisfied`,
`has_restricted_blockers` and `dependency_version`. Entries retain
`source_edges` and `inherited_from`; `blocking` lists direct successors with
visible descendant counts. Cross-project edges are allowed within one
workspace. Identifier resolution uses the same workspace prefix and membership
policy as ordinary issue GET. Missing and foreign references both return 404
with `reason_code=not_found`.

The projection accepts an issue-visibility predicate: hidden prerequisites and
source paths disclose no IDs, titles, edge IDs or counts. An invisible
unfinished prerequisite sets only `has_restricted_blockers`. The current
transport uses the existing workspace-membership visibility policy. Consumers
must retain the full server snapshot for decisions, rather than deciding from
the projected list, a project filter or a paginated task list.

`dependency_version` is an opaque HMAC of workspace, target/ancestor chain and
revisions, effective prerequisite status/revisions, source edges and status
catalog categories. A stale version fails in the write transaction. It is a
conservative concurrency token; unrelated text changes on those issues or
catalog changes may also require a refresh.

For compound writes, `blocked_by` accepts UUIDs or issue identifiers. Omission
leaves relations unchanged (empty on create); `[]` clears direct relations;
`null` is invalid. Replacements on PATCH require
`expected_dependency_version`. Repeated/order-independent references are
deduplicated without changing retained edge IDs or incrementing a no-op issue
revision. Existing POST/PUT/batch endpoints reject dependency-edit fields, so a
client cannot silently lose constraints by falling back to a legacy endpoint.

New clients use `ApiClient.getIssueDependencies`,
`createIssueWithDependencies` and `updateIssueWithDependencies`. New TypeScript
fields are camelCase; the boundary converts wire names. Missing/malformed
dependency data becomes `null` and readiness `unknown`, never an empty ready
set. The compound client does not retry POST/PUT after 404/405.

Errors carry `error` and `reason_code`: 409 for `dependency_unsatisfied`,
`dependency_cycle`, `dependency_ancestor_conflict` or
`dependency_version_conflict`; 403 for `dependency_change_not_allowed` or
`dependency_override_not_allowed`; 422 for `dependency_data_unverified`.
Malformed fields use 400. Unverified historical data never discloses raw
invalid endpoints. Batch update retains `updated` and adds per-item `results`,
including dependency rejection codes; each item is its own atomic mutation.

## Transaction and lock order

Structural/create/delete and status/assignment updates use:

1. Workspace row `FOR NO KEY UPDATE` (also the existing create counter lock).
2. Shared workspace status-catalog advisory lock.
3. Exclusive workspace dependency-structure advisory lock.
4. Requested attachment locks, when updating with new attachments.
5. Workspace issue rows in UUID order, then graph validation/mutation/audit.
6. Existing transaction-local side effects; commit before publishing events.

Issue rows are locked before reading prerequisite status. This stabilizes
status and revisions even for existing status producers outside HTTP. Ordinary
text/date/position edits use only their existing attachment/target locks;
top-level creates without prerequisites do not load the workspace graph.
Updates refresh untouched nullable fields under their target lock to avoid
overwriting a concurrent reparent or assignment with stale preloaded values.
Compound responses retain the committed transaction's snapshot rather than
mixing a post-commit graph read with an older issue revision.

Deletion validates before cancelling tasks or failing autopilot runs. These
database changes share the deletion transaction; runtime notifications occur
only after commit. Existing deletion cleanup and source-context retention are
preserved. Rejected creates/updates/deletes emit no task-start/cancel effects.

This first implementation serializes structural writes per workspace and locks
all its issue rows. It deliberately trades write concurrency for a simple
correctness boundary. Reads use MVCC. Reassess the lock scope with measurements
of realistic workspace size and contention before wide write enablement;
`LockIssueDependencyStructureShared` is available for the OL-41 integration.

## Stage boundary and follow-up

**Production compound writes return 404.** `WritesEnabled` defaults to false
and has no environment/configuration switch in this stage. Only an isolated
test's copied service enables it. GET and model/transaction helpers are
available for OL-40 and OL-41 development.

`CheckWriteAdmission` rejects a new machine assignment with unfinished
prerequisites even on backlog or with `suppress_run`. Unassigned backlog
planning remains valid. Before OL-41, any dependency-bearing run intent also
fails closed with 409 `dependency_dispatch_unavailable`, including when its
prerequisites are ready; `dependency_override` remains disabled. This prevents
the existing post-commit enqueue paths from advertising an atomic dispatch
guarantee they do not yet provide.

OL-41 must integrate the same validated snapshot and lock order with all
enqueue/claim producers, capacity/queue transactions, human override and
claim-time rechecks. Recheck lock interactions with existing task, comment,
attachment and automation writers during that integration. No arbitrary-edge
auto-dispatch is added (D2). OL-42 owns CLI `--blocked-by`; no CLI parameter or
dependency UI is enabled here. Follow the
[historical audit and recovery procedure](../../cmd/audit_issue_dependencies/README.md)
before enabling writes on an existing database.
