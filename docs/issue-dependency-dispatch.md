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
dispatch. No CLI flag or UI confirmation flow ships in OL-41.

## Execution coverage and validation

| Path | Boundary / evidence |
| --- | --- |
| Single, batch, create, inherited assignment / activation | `IssueService.Create`, `updateIssueAtomically`; `dependency_dispatch*_test.go` |
| Mention, reply, Squad leader, deferred channel/fallback | Shared `TaskService` admission; entrypoint matrix and comment tests |
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

Admission readers share locks and can run concurrently. They lock every issue
row in the workspace, so an unrelated title/status writer can wait behind them.
Repeated waits can accumulate into a long request even when each individual
lock wait is short. Do not judge this risk from average latency or p95 alone.

`TestDependencyAdmissionContention` exercises real enqueue, claim and issue-write
transactions at 100/1,000/5,000 nodes, 1/8/16 independent agent workers, with and
without two writers (title and status on unrelated issues). Each worker executes
100 enqueue/claim cycles after warmup. Each functional parent has two completed
prerequisites, inherited by its children: `E = V/2`, with one parent level.
Every claim must return exactly its new task with admission proof. Completion
is simulated outside the timing; no agent or daemon runs. Each case has a
two-minute deadline and all its goroutines are joined before returning.

Run alone against a disposable database containing all candidate migrations:

```bash
cd server
# Set DATABASE_URL to the isolated DB; include pool_max_conns=24 (or higher).
go run ./cmd/migrate up
DEPENDENCY_LOAD_TEST=1 ../scripts/go-test-with-agent-cli-guard.sh -- \
  go test ./internal/handler -run '^TestDependencyAdmissionContention$' \
  -count=1 -timeout=15m -json > dependency-load.jsonl
```

`DEPENDENCY_LOAD_ITERATIONS` increases samples per worker (default 100, minimum
10). Subtests can select a single size/concurrency case with `-run`. Records
prefixed `DEPENDENCY_LOAD_RESULT` contain sorted raw millisecond samples,
p50/p95/p99/max per operation, cycle throughput, failures and 10 ms `pg_locks`
samples. Reassemble Go JSON `Output` chunks before parsing a result line.
`max_observed_wait_ms` is an individual lock's observed age, not the total wait
of a request; inspect write `max_ms` as well. A Go test PASS means all operations
completed correctly, **not** that the deployment performance gate passed.

OL-45 must record candidate SHA, PostgreSQL/application versions, CPU/memory,
connection limits, graph sizes/density/depth, warm/cold behavior, workload and
the full results. Repeat on production-like resources with the intended peak
load and dense/deep shapes (including the OL-38 1,000-node/~5,000-edge sample),
plus competing workspaces and continuous writers. The sparse local fixture
does not establish capacity for those cases or a product node limit.

The initial review budget at the intended rollout load is p95 <= 500 ms,
p99 <= 1,000 ms and maximum <= 2,000 ms for each measured operation, with zero
deadlocks, timeouts, lost writes, duplicate or unauthorized executions. These
are acceptance targets, not measured guarantees; any change to them requires
an explicit rationale in OL-45. Missing evidence or a breached budget blocks
broad enablement. If writers starve, return the contention defect to OL-41,
prove any narrower lock scope covers the complete execution component and
re-run the existing relation/status/enqueue/claim concurrency tests. Do not
truncate the graph or bypass admission to meet the budget.

The 2026-09-09 local baseline **fails this performance gate**. With PostgreSQL
15.19, Go 1.27.1, 96 visible CPUs/GOMAXPROCS and 24 pool connections, all 18 sparse
cases completed 15,000 enqueue/claim cycles and 1,800 issue writes without an
execution or write failure. However, the 1,000-node/16-worker case reached 9.62 s
for a status write; the 5,000-node/16-worker case reached 41.53 s even though that
case's status-write p95 was only 48.03 ms. Lock contention is still unresolved;
these shared-host measurements justify the rollout hold, not a production
capacity claim. OL-41's follow-up validation attachment contains the raw samples.
