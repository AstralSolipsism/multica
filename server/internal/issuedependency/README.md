# Informational issue dependencies

This package models explicit `blocked_by` edges and parent-inherited
prerequisites. It supports the retained graph and relation-editing feature under
the [confirmed synchronization scope](../../../docs/engineering/upstream-sync-20260926.md).
Execution, claiming, retries, comment wakeups and automation use upstream rules.
This model cannot grant or deny execution.

## Model and validation

Edges connect issues in one workspace and may cross projects. Parentage alone
is not a prerequisite; descendants inherit an ancestor's explicit prerequisites.
Only each prerequisite's own effective `done` category marks it satisfied in
the displayed summary. Direct and inherited relations remain distinct.

Relation edits reject self edges, cycles, ancestor conflicts and references to
inaccessible workspaces. Versioned replacement prevents overwriting a concurrent
edit. Invalid historical data makes the affected graph/read/edit unavailable
instead of returning a misleading partial graph. Ordinary field edits and
execution do not use that condition as an execution gate. Deleting an issue
removes its incident edges and follows upstream deletion behavior.

The service layer owns transactional locking, persistence, relation audit and
opaque versions. The pure model owns graph validation and projection. Workspace
structure locking serializes structural edits; reads use a repeatable-read
snapshot. Related component selection keeps unrelated historical anomalies from
blocking ordinary edits. Projections sort their output for stable versions.

## Read and edit contracts

The [CLI/API reference](../service/builtin_skills/multica-platform/references/issue-dependencies.md)
is the current contract. `GET /api/issues/{id}/dependencies` returns visible
direct/inherited prerequisites, successors and unfinished summaries. Hidden
context is represented by markers without disclosing inaccessible IDs/titles.
The [complete graph API](../../../docs/issue-graph-api.md) returns a coherent
workspace/project snapshot. A graph's unfinished-prerequisite count is not an
execution status or permission.

The active implementation has no prerequisite admission service, signed early
execution permit, human-only relation-removal policy, or dependency-specific
dispatch result. Historical migrations and stored records are retained so that
existing databases upgrade without rewriting their ledger or deleting data.

Tests cover graph consistency, projections, versions, concurrent structural
edits, rollback and UUID stability. Handler regressions separately prove that
unfinished relations do not prevent ordinary assignment, enqueue, claim,
comment wakeups or machine-authored relation edits.
