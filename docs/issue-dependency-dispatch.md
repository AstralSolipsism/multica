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

Use an isolated PostgreSQL database migrated through 468 and the repository's
`scripts/go-test-with-agent-cli-guard.sh`. Fixtures use fake runtimes; tests must
not launch installed real-agent CLIs. The implementation uses complete workspace
snapshots and conservative row locks; large-workspace contention remains a
rollout measurement requirement, not an asserted performance guarantee.
