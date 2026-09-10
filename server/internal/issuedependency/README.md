# Issue prerequisites and execution admission (OL-39 / OL-41)

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

Dependency GET and compound writes strictly validate the entire workspace.
Legacy create/reparent/delete/admission checks instead validate the complete
connected component formed by parent links and canonical `blocked_by` edges,
in both directions. A reparent includes the old and proposed parent's components;
deletion also validates the surviving structure. This includes every potentially
affected ancestor, descendant, prerequisite and successor, without pagination.
Unrelated malformed history cannot disable ordinary issue operations across a
workspace. Unknown `blocks` and inert `related` rows are excluded only from this
execution check, not from storage or the strict workspace audit. Missing/foreign
endpoints, duplicate canonical rows and cycles **inside** the affected component
still fail closed; the service never treats a missing prerequisite as ready.
Ordinary reparenting does not rewrite relation rows. Explicit issue deletion
removes incident rows through the existing cleanup policy and records their
original contents in the same transaction's audit.

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

Create/delete and all ordinary issue updates use:

1. Workspace row `FOR KEY SHARE`; creates first take `FOR NO KEY UPDATE` for
   their existing counter update.
2. Shared workspace status-catalog advisory lock.
3. Exclusive workspace dependency-structure advisory lock.
4. Requested attachment locks, when updating with new attachments.
5. Workspace issue rows in UUID order, then graph validation/mutation/audit.
6. Existing transaction-local side effects; commit before publishing events.

Issue rows are locked before reading prerequisite status. This stabilizes
status and revisions even for existing status producers outside HTTP. Ordinary
text/date/position edits join the same structure-lock queue before their existing
attachment/target locks, but do not load the graph unless admission requires it;
top-level creates load the workspace graph when they also enqueue execution.
Status-only updates keep the ordered workspace row locks and decide execution
intent from the locked target. Without execution or an explicit dependency
write/view/version check, they skip loading and cloning the graph.
Updates refresh untouched nullable fields under their target lock to avoid
overwriting a concurrent reparent or assignment with stale preloaded values.
Compound responses retain the committed transaction's snapshot rather than
mixing a post-commit graph read with an older issue revision.

Deletion validates before cancelling tasks or failing autopilot runs. These
database changes share the deletion transaction; runtime notifications occur
only after commit. Existing deletion cleanup and source-context retention are
preserved. Rejected creates/updates/deletes emit no task-start/cancel effects.

Admission transactions take workspace `FOR KEY SHARE`, the shared catalog and
structure locks, then all workspace issue rows `FOR SHARE` in UUID order.
Capacity locks precede queue locks. Machine recovery locks multiple workspaces
in UUID order. This makes status producers, reparenting and graph edits serialize
against the dependency decision without changing completion permissions.
`KEY SHARE` still prevents workspace deletion, but is compatible with a writer's
`NO KEY UPDATE` counter lock. This lets the writer enter the exclusive structure
lock's wait queue, where later admissions wait behind it. Taking workspace
`SHARE` instead lets successive readers overtake the writer before it reaches
that queue. Text-only writers must also join this queue to avoid the same
starvation at the issue row. These writes serialize per workspace; they wait
for current admissions to finish, without requiring the reader stream to stop.
Only creates take the stronger counter lock: taking it for ordinary writes
would keep the second writer out of the structure queue behind the first,
allowing another reader batch between them. Creates retain the counter-first
order to avoid upgrading after catalog/structure/issue locks.
For standalone enqueue and compound assignment, external attribution/connected-app
preparation precedes the transaction;
queue insertion, confirmation audit and the compound issue mutation commit
before task events or runtime wakeups. Manual rerun retries its entire transaction
once if a concurrent provider retry acquires the pending slot.

PR #32 and migration 478 retired the separate Feishu feedback worker. The live
conversation path prepares external source/overlay data before the Chat
transaction; input, run and frozen delivery commit together. A task-token agent
then uses the ordinary comment handler. The load matrix exercises this full
path with and without a controlled external overlay delay. Caller-owned
transactions remain supported: a regression proves nested admission savepoints
keep row locks and queued writes until the outer transaction commits or rolls
back. Do not restore the retired worker to test that transaction contract.

The initial scope deliberately locks/loads the complete workspace rather than
introducing a second graph/cache or a partial-page approximation. This costs
O(V+E+H) data per admission and can delay unrelated issue edits in a large
workspace. Measure claim latency and lock waits against realistic size and
contention before a wide rollout; narrow locks only with an equivalent closure
proof and the concurrency tests intact.
Validation uses integer vertex/edge indexes; the edge query returns aligned
arrays from one input, so graph storage is allocated once. Loading orders the
final edge representation in memory, avoiding PostgreSQL temporary-file sorts,
reuses endpoint strings and avoids duplicate union rows. Ordered row-lock
queries drain their complete result on the server rather
than transferring unused IDs. A valid full graph already proves
each execution component valid, so the admission path selects/copies a component
only when historical corruption needs the existing component isolation.
The executable contention matrix, measurement limits and required OL-45 rollout
gate are in [`docs/issue-dependency-dispatch.md`](../../../docs/issue-dependency-dispatch.md#contention-gate-ol-45).
Concurrent shared admission locks do not themselves serialize readers; include
maximum write latency to detect starvation behind a sustained reader workload.

## Execution and one-shot confirmation

Compound writes are enabled after integration of the shared enqueue, claim,
retry and recovery gates. A workspace with unverified historical data still
fails strict dependency operations with 422; audit and repair the data using
[the historical audit procedure](../../cmd/audit_issue_dependencies/README.md).
Disabling compound writes must never disable canonical execution admission.

A new machine assignment with unfinished direct/inherited prerequisites fails
even on backlog or with `suppress_run`. A human may preassign without execution.
Only the existing assign/create/backlog-promotion predicate creates an automatic
run; completion/reporting does not become a new trigger. No arbitrary DAG-edge
auto-dispatch is introduced. Ordinary comments persist independently and report
blocked dispatch; they are never a confirmation, even from a human.

Enqueue and first claim use the same complete snapshot. A failed first claim is
quarantined as `failed` with a stable `dependency_*` reason, without credentials,
issue rollback or automatic retries, and scanning continues to the next row.
Corrupt/missing workspace bindings are rejected at this boundary as well.
Fresh provider retries, manual reruns, member/child tasks and recovery comments
never copy early-execution permission. A server-owned autopilot issue association
also gates legacy `run_only` rows with NULL `issue_id`; issue-less chat and planning
retain their existing behavior.

Only authenticated human JWT sessions may explicitly confirm. Task tokens,
PATs/cloud PATs, owner/originator attribution and forged headers cannot authorize
it. Preview signs a five-minute challenge over the user, workspace, issue,
executing agent/Squad leader, complete proposed mutation digest and dependency
version. Confirmation is rechecked in the mutation transaction and stores a
record on exactly one new queue row; its initial claim must occur within fifteen
minutes and rechecks dependencies, membership, invoke permission and leader.
If all prerequisites are now done, ordinary admission is sufficient.

`request_id` has a unique queue index. An identical signed replay is read-only
and returns the same task/run even after it finishes; changed input/target is
rejected. A small existing dependency-audit record prevents resurrection after
queue/issue deletion. Audit retention must preserve `dispatch_confirmation`
records for at least the challenge lifetime. Claim stamps `consumed_at` in the
same transaction as dispatch; lost-response/claim-finalization recovery of that
same row is safe and does not mint another permit. Historical dispatched rows
without proof are validated before recovery delivery.

The transport and frontend contract, request examples and test map live in
[`docs/issue-dependency-dispatch.md`](../../../docs/issue-dependency-dispatch.md).
OL-42 owns CLI `--blocked-by` and confirmation UX; this PR adds no UI or CLI flags.
Migrations 467/468 add nullable queue metadata and its concurrent unique index.
Deploy schema before the upgraded server. Rolling back the server to a version
without admission while canonical edges exist is unsafe; first drain/stop new
execution or keep admission enabled. Never drop the column to revoke one task.
