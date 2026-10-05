-- name: LockWorkspaceForDependencyWrite :one
-- Take the create counter's row lock first, avoiding a later lock upgrade.
SELECT id FROM workspace WHERE id = $1 FOR NO KEY UPDATE;

-- name: LockWorkspaceForDependencyStructure :one
-- Fence workspace deletion without conflicting with the create counter's
-- NO KEY UPDATE lock. Structural writers serialize on the advisory lock.
SELECT id FROM workspace WHERE id = $1 FOR KEY SHARE;

-- name: LockIssueDependencyStructure :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg('workspace_id')::uuid::text || ':issue_dependency', 0));

-- name: ListIssueDependencyNodes :many
SELECT id, parent_issue_id, status, revision, title, number FROM issue
WHERE workspace_id = $1 ORDER BY id;

-- name: ListIssueDependencyEdges :one
-- Include either local endpoint so corrupt cross-workspace edges fail closed.
-- Reuse the local UUID set in both indexable endpoint joins. NOT IN is safe
-- here because issue.id is non-null; it excludes duplicates without a source
-- row lookup per edge when a new workspace is absent from planner statistics.
-- One input keeps arrays aligned and avoids per-row protocol/scan overhead.
WITH local AS MATERIALIZED (
    SELECT id FROM issue WHERE workspace_id = $1
), edges AS (
    SELECT d.id, d.issue_id, d.depends_on_issue_id, d.type
    FROM local i JOIN issue_dependency d ON d.issue_id = i.id
    UNION ALL
    SELECT d.id, d.issue_id, d.depends_on_issue_id, d.type
    FROM local i JOIN issue_dependency d ON d.depends_on_issue_id = i.id
    WHERE d.issue_id NOT IN (SELECT id FROM local)
)
SELECT coalesce(array_agg(id), '{}')::uuid[] AS ids,
       coalesce(array_agg(issue_id), '{}')::uuid[] AS issue_ids,
       coalesce(array_agg(depends_on_issue_id), '{}')::uuid[] AS depends_on_ids,
       coalesce(array_agg(type), '{}')::text[] AS types
FROM edges;

-- name: InsertIssueDependency :exec
INSERT INTO issue_dependency (id, issue_id, depends_on_issue_id, type)
SELECT sqlc.arg('id'), i.id, p.id, 'blocked_by'
FROM issue i JOIN issue p ON p.workspace_id = i.workspace_id
WHERE i.workspace_id = sqlc.arg('workspace_id') AND i.id = sqlc.arg('issue_id') AND p.id = sqlc.arg('depends_on_issue_id')
ON CONFLICT (issue_id, depends_on_issue_id) WHERE type = 'blocked_by' DO NOTHING;

-- name: DeleteDirectIssueDependencies :exec
DELETE FROM issue_dependency d USING issue i
WHERE i.workspace_id = sqlc.arg('workspace_id') AND i.id = sqlc.arg('issue_id')
AND d.issue_id = i.id AND d.type = 'blocked_by'
AND NOT (d.depends_on_issue_id = ANY(sqlc.arg('retained_ids')::uuid[]));

-- name: RecordIssueDependencyAudit :exec
INSERT INTO issue_dependency_audit (id, workspace_id, issue_id, actor_id, credential_kind, action, before_state, after_state)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: TouchIssueDependencyRevision :one
UPDATE issue SET revision = revision + 1, updated_at = now(), last_activity_at = now()
WHERE workspace_id = $1 AND id = $2 RETURNING *;
