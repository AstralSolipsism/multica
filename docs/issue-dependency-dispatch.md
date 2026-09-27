# Issue dependencies after upstream synchronization

The dependency execution policy was retired by the confirmed
[upstream synchronization decisions](engineering/upstream-sync-20260926.md).

Dependency edges, inherited relation summaries, graph views and versioned edits
remain available for planning. They do not block assignment, enqueue, claim,
retry, comments, automation, or Squad execution. These use upstream rules.
There is no one-shot dependency override, human-only relation removal, or
dependency-specific dispatch result. Historical migrations and stored records
remain to preserve existing databases; they do not activate the retired policy.

The current [CLI and API contract](../server/internal/service/builtin_skills/multica-platform/references/issue-dependencies.md)
documents informational relations and graph validation. Regression coverage is
in `dependency_informational_test.go`, `dependency_cli_test.go`,
`issue_dependency_test.go`, and the issue graph tests. No real agent CLI is
required or permitted by the default tests.
