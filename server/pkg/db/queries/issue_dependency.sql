-- name: LockWorkspaceForDependencyWrite :one
-- Take the create counter's row lock first, avoiding a later lock upgrade.
SELECT id FROM workspace WHERE id = $1 FOR NO KEY UPDATE;

-- name: LockWorkspaceForDependencyAdmission :one
-- Fence workspace deletion, but let structural writers reach the advisory
-- lock's wait queue. SHARE conflicts with their NO KEY UPDATE counter lock
-- and a continuous stream of admissions can starve them before that queue.
SELECT id FROM workspace WHERE id = $1 FOR KEY SHARE;

-- name: LockIssuesForDependencyAdmission :exec
SELECT id FROM issue WHERE workspace_id = $1 ORDER BY id FOR SHARE;

-- name: SetTaskDependencyAdmission :one
UPDATE agent_task_queue SET dependency_admission = $2 WHERE id = $1 RETURNING *;

-- name: GetTaskByDependencyRequest :one
SELECT * FROM agent_task_queue WHERE dependency_admission->>'request_id' = $1::text;

-- name: RejectTaskDependencyAdmission :one
UPDATE agent_task_queue SET status='failed', completed_at=now(),
    error=$2, failure_reason=$3, prepare_lease_expires_at=NULL
WHERE id=$1 AND status IN ('queued','deferred','dispatched') AND started_at IS NULL
RETURNING *;

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
-- every relation in every workspace. The disjoint second arm avoids sorting or
-- hashing the full duplicate edge set while preserving corrupt inbound edges.
SELECT d.id, d.issue_id, d.depends_on_issue_id, d.type
FROM issue i JOIN issue_dependency d ON d.issue_id = i.id
WHERE i.workspace_id = $1
UNION ALL
SELECT d.id, d.issue_id, d.depends_on_issue_id, d.type
FROM issue i JOIN issue_dependency d ON d.depends_on_issue_id = i.id
WHERE i.workspace_id = $1
AND NOT EXISTS (SELECT 1 FROM issue source WHERE source.id = d.issue_id AND source.workspace_id = $1)
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

-- name: GetPendingTaskForIssueAndAgent :one
SELECT * FROM agent_task_queue WHERE issue_id=$1 AND agent_id=$2
AND (status IN ('queued','dispatched') OR (status='deferred' AND context->>'channel_issue_media_pending'='true'))
AND (COALESCE(sqlc.narg('head_sha')::text,'')='' OR context->>'head_sha'=sqlc.narg('head_sha')::text)
ORDER BY created_at,id LIMIT 1;

-- name: HasDependencyConfirmationRequest :one
-- Keep a denial tombstone in the existing relation audit after issue/task
-- deletion, so a still-signed create request cannot resurrect its execution.
SELECT EXISTS (SELECT 1 FROM issue_dependency_audit WHERE workspace_id=$1
AND action='dispatch_confirmation' AND after_state->>'request_id'=sqlc.arg('request_id')::text);

-- name: LockAutopilotRunForDependencyAdmission :one
SELECT * FROM autopilot_run WHERE id=$1 FOR UPDATE;

-- name: BindTaskDependencyIssue :one
UPDATE agent_task_queue SET issue_id=$2 WHERE id=$1 AND issue_id IS NULL RETURNING *;
