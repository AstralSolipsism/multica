# Issue dependency dispatch contract (OL-41)

The canonical OL-38 v2 / OL-39 model remains authoritative: only each direct or
inherited prerequisite's current effective `done` category satisfies it.
Existing completion permissions, backlog planning and stage barriers remain.
No completion event automatically dispatches arbitrary DAG successors.

## Preview and confirmation

`POST /api/issues/preview-trigger` keeps its existing fields and adds `mutation`,
the **entire exact compound create/update body**, without `dependency_override`.
For existing issues supply `issue_ids`; for creation supply `is_create: true`.
The server resolves the actual executing agent, including a Squad leader.

```json
{
  "issue_ids": ["<B UUID>"],
  "mutation": {
    "assignee_type": "agent",
    "assignee_id": "<agent UUID>",
    "status": "todo"
  }
}
```

Ready work remains in `triggers`; `total_count` counts ready triggers only.
Blocked candidates appear in `blocked` with `issue_id`, `reason_code` and the
complete dependency projection. Only human JWT requests can receive
`confirmation: {request_id, challenge, expires_at}`. Missing `mutation` provides
diagnostics without a confirmation. Preview is advisory; the transaction and
first claim always check again.

Mutation bodies must be JSON objects. If canonicalization fails (including
`mutation: null`), the server returns HTTP 400 `invalid mutation payload` before
issuing a challenge or writing data. Batch confirmations validate the shared
`updates` body once before the first item. The warning `dependency payload digest
failed` includes request/client context, never the mutation or confirmation.

After displaying blockers and receiving the human's explicit choice, submit
the same mutation to `PATCH /api/issues/{id}/with-dependencies` or
`POST /api/issues/with-dependencies`, adding:

```json
{
  "dependency_override": {
    "request_id": "<preview request_id>",
    "challenge": "<preview challenge>"
  }
}
```

The signed challenge binds all fields, current dependencies, target, workspace
and human. Whitespace/key order is irrelevant; adding or changing any mutation
field requires another preview. Challenge lifetime is five minutes, and first
claim must occur within fifteen minutes of confirmation. A repeated confirmation
returns the original task even after completion; it never reapplies the mutation
or emits another task event. Changed data/permissions/leader produces a stale or
not-allowed result. Expired unused requests require a new preview.

## Outcome and errors

Committed create/update responses add `dispatch`, using the existing vocabulary:

| Status | Meaning |
| --- | --- |
| `queued` | A new task was committed; `task_id` and `run_id` identify it. |
| `coalesced` | An existing task covers this request, including confirmed replay. |
| `deferred` | No new execution, or a media-gated task scheduled for later. |
| `blocked` | Dispatch refused; `reason_code` explains why. |

Compound mutation refusals return the existing HTTP error envelope and leave
issue fields, relations, revision, admission audit and queue unchanged. Dependency
reasons include `dependency_unsatisfied`, `dependency_data_unverified`,
`dependency_version_conflict`, `dependency_override_not_allowed`,
`dependency_override_stale`, and `dependency_override_expired`. Existing graph
validation and visibility errors remain unchanged. A blocked prerequisite may
be hidden; `has_restricted_blockers` still prevents readiness.

Ordinary comments and their edits can persist while `trigger_outcomes` reports
`blocked / dependency_unsatisfied`. A pending confirmation cannot authorize an
unrelated comment merge. Existing active-run input is retained by the original
completion/reconciliation flow; any later fresh task checks again.

`POST /api/issues/batch-update` retains partial success and adds optional
`dependency_overrides`, a map from issue UUID to that item's confirmation.
Each item signs the exact shared `updates` body and returns its own `dispatch` or
structured refusal in `results`. Never carry one item's confirmation to another.
Legacy create/update cannot accept dependency fields and clients must not fall
back after an ambiguous write response or a 404/405.

Core exposes camelCase dependency and outcome fields. Use
`ApiClient.previewIssueTrigger`, `createIssueWithDependencies`,
`updateIssueWithDependencies`, and `batchUpdateIssues`' third argument.
`parseWithFallback` preserves committed issue data while malformed additive
diagnostics become `null`. Missing queue/run identity cannot parse as successful
dispatch. OL-42 adds CLI relationship commands and refusal output; the human
confirmation interaction remains the UI/API contract above.

## CLI integration (OL-42)

`issue create/update --blocked-by <issue-key-or-uuid>` is repeatable. Create
submits one compound POST; update reads `dependency_version` and submits one
compound PATCH replacing the complete direct set. `update --clear-blocked-by`
submits `[]` and is mutually exclusive with `--blocked-by`.
`issue dependency list/add/remove <issue>` share the same endpoints; add/remove
require `--blocked-by` and carry the read version without conflict retries.
Only direct edges are edited; inherited and unfinished prerequisites remain
separate in JSON and table output. Unknown/malformed read data prevents edits.

Ordinary commands retain their old endpoints, which still enforce admission.
With `--output json`, dependency HTTP errors preserve their full JSON up to
1 MiB (including projections larger than the CLI's former 4 KiB error cap) on
stdout and return the existing nonzero exit classification. Larger issue error
bodies produce a local `body_truncated: true` diagnostic with the HTTP status;
incomplete projections are not emitted as server JSON and never cause a retry.
`--output table` emits readable refusal guidance on stderr only.
A 404/405 never causes a fallback write. A saved comment
with a blocked target prints the saved comment and all outcomes, then exits 1
with guidance not to repost. Partial success can include other queued targets.

`TestDependencyCLI*` in `server/cmd/multica` runs real CLI process entry points
against isolated HTTP peers for parameters, versions, compatibility, JSON and
exit codes. `TestDependencyCLIIntegration` in `server/internal/handler` builds
the CLI and runs it against real handlers, auth and PostgreSQL, including the
human JWT preview/confirmation API. Both use only test credentials and fake
runtimes. Run with the agent CLI guard; no force/override CLI flag is provided.

## Execution coverage and validation

| Path | Boundary / evidence |
| --- | --- |
| Single, batch, create, inherited assignment / activation | `IssueService.Create`, `updateIssueAtomically`; `dependency_dispatch*_test.go` |
| Mention, reply, Squad leader, deferred channel/fallback | Shared `TaskService` admission; entrypoint matrix and comment tests |
| Feishu conversation feedback | Source/consent → atomic Chat input/run/frozen delivery → claim → authenticated agent comment; load with and without overlay. PR #32/migration 478 retired the separate recovery worker. |
| Caller-owned transaction admission | Nested savepoint commit/rollback and retained prerequisite locks in `dependency_dispatch_lock_test.go` |
| Queue claim, runtime claim, machine batch, legacy recovery | Admission before credentials, skip rejected queue head, existing capacity/claim regressions |
| Manual rerun, provider retry and retry sweeper | Fresh admission; atomic replacement; concurrent fail/rerun regressions |
| Delegated recovery, parent/stage wake, webhook callers | Shared enqueue boundary; existing delegated/child-done tests |
| Autopilot create and run-only, including legacy NULL issue binding | Atomic insertion; effective server-owned issue binding checked again at claim |
| One-shot authority and replay | Real JWT/PAT/task-token middleware; stale/expiry/permission/leader/deletion/concurrent replay tests |
| Atomic failure and concurrency | Real PostgreSQL insertion fault and observed blocking locks; revision/relations/audit rollback |
| Client boundary | Serialization parity, partial batches, missing/malformed preview/confirmation/dispatch tests |

Use an isolated PostgreSQL database with all candidate migrations (including
`467_task_dependency_admission` / `468_task_dependency_request_index`) and the
repository's
`scripts/go-test-with-agent-cli-guard.sh`. Fixtures use fake runtimes; tests must
not launch installed real-agent CLIs. The implementation uses complete workspace
snapshots and conservative row locks. The contention gate below must be accepted
in OL-45 before broad rollout.

## Contention gate (OL-45)

Admission readers take workspace `KEY SHARE` and shared catalog/structure locks.
Known-target admissions load the whole graph, then lock and refresh only the
target, its ancestors and all their explicit prerequisites in UUID order. Claims
read queued target IDs first, lock their combined status inputs, then restrict
claim SQL to those targets and issue-less chat/planning. Concurrently queued
other targets wait for a fresh poll. Existing unbound run-only claims and
multi-workspace recovery retain all issue rows `SHARE`. Complete graph validation
is unchanged;
execution does not sort the whole edge list, while public views and versions
retain their stable output ordering. Ordinary title/status writers enter the existing
exclusive structure-lock queue before locking issue rows; later readers wait
behind the queued writer. Ordinary writers use the same workspace `KEY SHARE`
fence; only creates first acquire the stronger counter lock. This lets multiple
writers enter the structure queue together. Workspace deletion remains fenced. Full snapshots
still cost O(V+E), and writers still wait for the current reader batch. Measure
request maxima as well as individual lock waits and average latency.

`TestDependencyAdmissionContention` exercises real enqueue, claim and issue-write
transactions at 100/1,000/5,000 nodes, 1/8/16 independent agent workers, with and
without two writers (title and status on unrelated issues). Each worker executes
100 enqueue/claim cycles after warmup. Each functional parent has two completed
prerequisites, inherited by its children: `E = V/2`, with one parent level.
Every claim must return exactly its new task with admission proof. Completion
is simulated outside the timing; no agent or daemon runs. Each case has a
five-minute deadline and all its goroutines are joined before returning.

Nine additional cases use 16 workers and two writers unless stated otherwise:

| Case | Shape / additional coverage |
| --- | --- |
| `dense` | 5,000 nodes / 40,000 edges |
| `dense_reference` | OL-38 reference: 1,000 nodes / 5,000 edges |
| `deep` | 5,000 nodes / 2,500 edges, 1,250 ancestor levels |
| `multi_workspace` | Four competing workspaces, each 5,000 nodes / 2,500 edges |
| `sustained` | At least 100 cycles per worker and 30 seconds of continuous load |
| `title_only` | Same sustained load, one title writer and no status writer |
| `overlay` | Enabled fake provider with 100 ms external preparation per enqueue |
| `feishu` / `feishu_overlay` | Current full conversation transaction and agent comment, with/without that overlay; 5,000 graph nodes plus 16 feedback issues |

Exact claimed IDs must be unique; queue/input/comment/delivery counts and final
issue revisions/values must match acknowledged operations, including warmup.
The deterministic lock regressions separately prove waiting-writer precedence,
workspace deletion fencing, savepoint settlement and overlay revalidation.
Known-target regressions also hold an unrelated issue lock during a real enqueue,
change prerequisite status while admission waits for its row lock, reject reuse
of a scoped snapshot for another target, and preserve current parent/assignee
fields across plugin content edits. A projection regression checks identical
views and signed versions when admission traverses edges in reverse order.
Claim regressions hold an unrelated status row, enqueue a higher-priority target
after the candidate read, and check that foreign target/ancestor/prerequisite
bindings are quarantined while the next valid task remains claimable.

Run alone against a disposable database containing all candidate migrations:

```bash
cd server
# Set DATABASE_URL to the isolated DB; use the same pool size in both versions.
# The recorded comparison uses pool_max_conns=24.
go run ./cmd/migrate up
DEPENDENCY_LOAD_TEST=1 DEPENDENCY_LOAD_ENFORCE_SLO=1 \
  ../scripts/go-test-with-agent-cli-guard.sh -- \
  go test ./internal/handler -run '^TestDependencyAdmissionContention$' \
  -count=1 -timeout=30m -json > dependency-load.jsonl
```

`DEPENDENCY_LOAD_ITERATIONS` increases samples per worker (default 100, minimum
10). Subtests can select a single size/concurrency case with `-run`. Records
prefixed `DEPENDENCY_LOAD_RESULT` contain sorted raw millisecond samples,
p50/p95/p99/max per operation, cycle throughput, failures and 10 ms `pg_locks`
samples with waiter PID, statement, blocking PIDs and lock age. Reassemble Go
JSON `Output` chunks before parsing a result line.
`max_observed_wait_ms` is an individual lock's observed age, not the total wait
of a request; inspect write `max_ms` as well. A Go test PASS means all operations
completed correctly, **not** that the deployment performance gate passed,
unless `DEPENDENCY_LOAD_ENFORCE_SLO=1` is set. Every result also includes
`performance_passed`; baseline runs may omit enforcement to collect all cases.

OL-45 must record candidate SHA, PostgreSQL/application versions, CPU/memory,
connection limits, graph sizes/density/depth, warm/cold behavior, workload and
the full results. Repeat on production-like resources with the intended peak
load and dense/deep shapes (including the OL-38 1,000-node/~5,000-edge sample),
plus competing workspaces and continuous writers. The expanded local matrix
does not establish a production capacity guarantee or a product node limit.

The initial review budget at the intended rollout load is p95 <= 500 ms,
p99 <= 1,000 ms and maximum <= 2,000 ms for each measured operation, with zero
deadlocks, timeouts, lost writes, duplicate or unauthorized executions. These
are acceptance targets, not measured guarantees; any change to them requires
an explicit rationale in OL-45. Missing evidence or a breached budget blocks
broad enablement. If writers starve, return the contention defect to OL-41,
prove any narrower lock scope stabilizes every decision input while preserving
complete structural validation, and
re-run the existing relation/status/enqueue/claim concurrency tests. Do not
truncate the graph or bypass admission to meet the budget.

The 2026-09-09 local baseline **fails this performance gate**. With PostgreSQL
15.19, Go 1.27.1, 96 visible CPUs/GOMAXPROCS and 24 pool connections, all 18 sparse
cases completed 15,000 enqueue/claim cycles and 1,800 issue writes without an
execution or write failure. However, the 1,000-node/16-worker case reached 9.62 s
for a status write; the 5,000-node/16-worker case reached 41.53 s even though that
case's status-write p95 was only 48.03 ms. That baseline used workspace `SHARE`
and allowed text-only writers to bypass the structure queue. The OL-41 repair
addresses those starvation points, reserves the counter lock for creates, and reduces dense-graph allocations and
duplicate edge-query work. OL-41's contention-fix attachments contain the
same-resource before/after comparison and raw samples. OL-45 still revalidates
the combined backend/frontend candidate before rollout.
