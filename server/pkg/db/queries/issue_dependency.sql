-- name: LockWorkspaceForDependencyWrite :one
-- Take the create counter's row lock first, avoiding a later lock upgrade.
SELECT id FROM workspace WHERE id = $1 FOR NO KEY UPDATE;

-- name: LockIssueDependencyStructure :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg('workspace_id')::uuid::text || ':issue_dependency', 0));

-- name: LockIssueDependencyStructureShared :exec
SELECT pg_advisory_xact_lock_shared(hashtextextended(sqlc.arg('workspace_id')::uuid::text || ':issue_dependency', 0));

-- name: LockIssuesForDependencyWrite :exec
-- The first implementation serializes structural edits per workspace. Lock
-- status rows in UUID order before inspecting unfinished constraints.
SELECT id FROM issue WHERE workspace_id = $1 ORDER BY id FOR UPDATE;

-- name: ListIssueDependencyNodes :many
SELECT id, parent_issue_id, status, revision, title, number FROM issue
WHERE workspace_id = $1 ORDER BY id;

-- name: ListIssueDependencyEdges :many
-- Include either local endpoint so corrupt cross-workspace edges fail closed.
-- Separate joins can use the existing endpoint indexes without correlating
-- every relation in every workspace. UNION removes the overlap by row identity.
SELECT d.* FROM issue i JOIN issue_dependency d ON d.issue_id = i.id
WHERE i.workspace_id = $1
UNION
SELECT d.* FROM issue i JOIN issue_dependency d ON d.depends_on_issue_id = i.id
WHERE i.workspace_id = $1
ORDER BY id;

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

-- name: DeleteIssueDependencies :exec
DELETE FROM issue_dependency d USING issue i
WHERE i.workspace_id = sqlc.arg('workspace_id') AND i.id = ANY(sqlc.arg('issue_ids')::uuid[])
AND (d.issue_id = i.id OR d.depends_on_issue_id = i.id);

-- name: RecordIssueDependencyAudit :exec
INSERT INTO issue_dependency_audit (id, workspace_id, issue_id, actor_id, credential_kind, action, before_state, after_state)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: TouchIssueDependencyRevision :one
UPDATE issue SET revision = revision + 1, updated_at = now(), last_activity_at = now()
WHERE workspace_id = $1 AND id = $2 RETURNING *;
