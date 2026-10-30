-- name: CreateMediaJob :one
-- Serialize the no-FK insert with workspace teardown and membership removal.
WITH authorized_workspace AS MATERIALIZED (
    SELECT w.id FROM workspace w JOIN member m ON m.workspace_id = w.id
    WHERE w.id = @workspace_id AND m.user_id = @caller_id
    FOR KEY SHARE OF w, m
)
INSERT INTO media_job (workspace_id, caller_id, uploader_type, uploader_id, task_id, issue_id, chat_session_id, request)
SELECT id, @caller_id, @uploader_type, @uploader_id, sqlc.narg(task_id), sqlc.narg(issue_id), sqlc.narg(chat_session_id), @request
FROM authorized_workspace
RETURNING *;

-- name: GetMediaJob :one
SELECT * FROM media_job WHERE id = @id AND workspace_id = @workspace_id;

-- name: LockMediaJob :one
SELECT * FROM media_job WHERE id = @id AND workspace_id = @workspace_id FOR UPDATE;

-- name: ExpireMediaJobs :exec
UPDATE media_job SET state = 'failed', error = 'job deadline exceeded', updated_at = now()
WHERE workspace_id = @workspace_id AND state IN ('queued','running') AND expires_at <= now();

-- name: QueuedMediaJobs :many
SELECT j.* FROM media_job j
JOIN agent_runtime r ON r.id = @runtime_id AND r.workspace_id = j.workspace_id
WHERE j.workspace_id = @workspace_id AND j.state = 'queued' AND j.expires_at > now()
  AND (r.owner_id = j.caller_id OR r.visibility = 'public' OR (r.visibility = 'private' AND j.caller_id = ANY(r.shared_with)))
  AND EXISTS (SELECT 1 FROM member m WHERE m.workspace_id = j.workspace_id AND m.user_id = j.caller_id)
  AND EXISTS (SELECT 1 FROM jsonb_to_recordset(@routes::jsonb) AS route(provider text, capability text)
      WHERE j.request->>'provider' IN ('auto', route.provider) AND j.request->>'capability' = route.capability)
ORDER BY j.created_at, j.id LIMIT 50 FOR UPDATE OF j SKIP LOCKED;

-- name: SettleMediaRuntimeJobs :exec
-- A new claim from the serial worker ends its previous assignment.
UPDATE media_job SET state = CASE WHEN attachment_id IS NOT NULL THEN 'completed' ELSE 'failed' END,
error = CASE WHEN attachment_id IS NOT NULL THEN '' ELSE 'assignment lost' END, updated_at = now()
WHERE workspace_id = @workspace_id AND runtime_id = @runtime_id AND state = 'running';

-- name: AvailableMediaRuntimes :many
SELECT r.* FROM agent_runtime r WHERE r.workspace_id = @workspace_id AND r.status = 'online'
AND r.daemon_id IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM media_job j WHERE j.runtime_id = r.id AND j.state = 'running' AND j.expires_at > now())
ORDER BY r.id;

-- name: StartMediaJob :one
UPDATE media_job SET state = 'running', runtime_id = @runtime_id, attempt = @attempt,
capability_tag = @capability_tag, attempts = attempts + 1, error = '', updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id AND state = 'queued' RETURNING *;

-- name: FinishMediaJob :one
UPDATE media_job SET state = @state, error = @error, updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id RETURNING *;

-- name: AttachMediaJob :one
UPDATE media_job SET attachment_id = @attachment_id, updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id RETURNING *;

-- name: CoolMediaRuntime :exec
UPDATE agent_runtime SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{media_cooldowns}',
COALESCE(metadata->'media_cooldowns', '{}'::jsonb) || jsonb_build_object(@capability::text, @until_epoch::bigint)), updated_at = now()
WHERE id = @id AND workspace_id = @workspace_id;

-- name: DeleteMediaJobsForWorkspace :exec
DELETE FROM media_job WHERE workspace_id = @workspace_id;
