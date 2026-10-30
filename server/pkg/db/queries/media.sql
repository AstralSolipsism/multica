-- name: UpsertMediaExecutor :one
-- Re-registration only refreshes observations and the connection lease. The
-- immutable identity fence prevents moving an executor between runtimes or
-- credentials. Reservations, cooldown and outstanding attempts are untouched.
INSERT INTO media_executor (
 workspace_id, runtime_id, daemon_id, executor_id, credential_scope_id,
 provider, capability, descriptor_version, descriptor, quota_ref, readiness,
 observed_at, max_concurrency, connection_id, connection_expires_at
) VALUES (
 @workspace_id, @runtime_id, @daemon_id, @executor_id, @credential_scope_id,
 @provider, @capability, @descriptor_version, @descriptor, @quota_ref, @readiness,
 @observed_at, @max_concurrency, @connection_id, now() + interval '90 seconds'
)
ON CONFLICT (workspace_id, executor_id) DO UPDATE SET
 descriptor = CASE WHEN EXCLUDED.observed_at >= media_executor.observed_at THEN EXCLUDED.descriptor ELSE media_executor.descriptor END,
 plan_quota = CASE WHEN EXCLUDED.observed_at >= media_executor.observed_at AND EXCLUDED.quota_ref IS DISTINCT FROM media_executor.quota_ref THEN NULL ELSE media_executor.plan_quota END,
 quota_ref = CASE WHEN EXCLUDED.observed_at >= media_executor.observed_at THEN EXCLUDED.quota_ref ELSE media_executor.quota_ref END,
 readiness = CASE WHEN EXCLUDED.observed_at >= media_executor.observed_at THEN EXCLUDED.readiness ELSE media_executor.readiness END,
 observed_at = GREATEST(EXCLUDED.observed_at, media_executor.observed_at),
 max_concurrency = CASE WHEN EXCLUDED.observed_at >= media_executor.observed_at THEN EXCLUDED.max_concurrency ELSE media_executor.max_concurrency END,
 connection_id = EXCLUDED.connection_id,
 connection_expires_at = EXCLUDED.connection_expires_at,
 updated_at = now()
WHERE media_executor.runtime_id = EXCLUDED.runtime_id
 AND media_executor.daemon_id = EXCLUDED.daemon_id
 AND media_executor.credential_scope_id = EXCLUDED.credential_scope_id
 AND media_executor.provider = EXCLUDED.provider
 AND media_executor.capability = EXCLUDED.capability
 AND (media_executor.connection_id = EXCLUDED.connection_id OR media_executor.connection_expires_at <= now())
RETURNING *;

-- name: RenewMediaExecutor :execrows
-- Heartbeats cannot register a new executor or take over another connection.
UPDATE media_executor SET
 descriptor = CASE WHEN @observed_at::bigint >= observed_at THEN @descriptor ELSE descriptor END,
 plan_quota = CASE WHEN @observed_at::bigint >= observed_at AND @quota_ref::jsonb IS DISTINCT FROM quota_ref THEN NULL ELSE plan_quota END,
 quota_ref = CASE WHEN @observed_at::bigint >= observed_at THEN @quota_ref ELSE quota_ref END,
 readiness = CASE WHEN @observed_at::bigint >= observed_at THEN @readiness ELSE readiness END,
 max_concurrency = CASE WHEN @observed_at::bigint >= observed_at THEN @max_concurrency ELSE max_concurrency END,
 observed_at = GREATEST(@observed_at::bigint, observed_at),
 connection_expires_at = now() + interval '90 seconds', updated_at = now()
WHERE workspace_id = @workspace_id AND runtime_id = @runtime_id AND daemon_id = @daemon_id
 AND executor_id = @executor_id AND credential_scope_id = @credential_scope_id
 AND provider = @provider AND capability = @capability AND connection_id = @connection_id
 AND connection_expires_at > now();

-- name: UpdateMediaExecutorQuota :execrows
UPDATE media_executor SET plan_quota = @plan_quota, updated_at = now()
WHERE workspace_id = @workspace_id AND runtime_id = @runtime_id AND executor_id = @executor_id
 AND connection_id = @connection_id AND connection_expires_at > now()
 AND (plan_quota IS NULL OR (
   COALESCE((plan_quota->>'observed_at')::bigint, 0) < @observed_at::bigint
   AND ((plan_quota - 'observed_at') IS DISTINCT FROM @content::jsonb
     OR COALESCE((plan_quota->>'observed_at')::bigint, 0) <= @freshness_before::bigint)
 ));

-- name: RevokeMissingMediaExecutors :exec
UPDATE media_executor SET readiness = 'unhealthy', connection_expires_at = now(), updated_at = now()
WHERE workspace_id = @workspace_id AND runtime_id = @runtime_id AND connection_id = @connection_id
 AND NOT (executor_id = ANY(@executor_ids::uuid[]));

-- name: ListMediaExecutors :many
SELECT * FROM media_executor WHERE workspace_id = @workspace_id AND runtime_id = @runtime_id ORDER BY executor_id;

-- name: ListUsableMediaExecutors :many
-- Caller checks membership and carries the original initiating human, never
-- substitutes an administrator or daemon owner for the invoking principal.
SELECT e.* FROM media_executor e JOIN agent_runtime r ON r.id = e.runtime_id AND r.workspace_id = e.workspace_id
WHERE e.workspace_id = @workspace_id
 AND r.owner_id IS NOT NULL
 AND (r.owner_id = @user_id OR r.visibility = 'public' OR (r.visibility = 'private' AND @user_id = ANY(r.shared_with)))
 AND r.status = 'online' AND r.last_seen_at > now() - interval '90 seconds'
 AND e.readiness = 'ready' AND e.connection_expires_at > now()
 AND e.capability = @capability
ORDER BY e.executor_id;

-- name: UpdateMediaRuntimeMetadata :exec
UPDATE agent_runtime SET metadata = jsonb_set(jsonb_set(metadata, '{media_executors}', @descriptors::jsonb), '{capabilities}', @capabilities::jsonb)
WHERE workspace_id = @workspace_id AND id = @runtime_id;

-- name: CreateMediaJob :one
INSERT INTO media_job (workspace_id, initiating_principal_type, initiating_principal_id, initiating_user_id,
 task_id, issue_id, capability, requested_provider, requested_model, immutable_request, request_hash, idempotency_key, deadline_at)
VALUES (@workspace_id, @initiating_principal_type, @initiating_principal_id, @initiating_user_id,
 @task_id, @issue_id, @capability, @requested_provider, @requested_model, @immutable_request, @request_hash, @idempotency_key, @deadline_at)
ON CONFLICT (workspace_id, initiating_principal_type, initiating_principal_id, idempotency_key)
DO NOTHING RETURNING *;

-- name: GetMediaJob :one
SELECT * FROM media_job WHERE workspace_id = @workspace_id AND id = @id;

-- name: GetMediaJobByIdempotencyKey :one
SELECT * FROM media_job WHERE workspace_id = @workspace_id AND initiating_principal_type = @initiating_principal_type
 AND initiating_principal_id = @initiating_principal_id AND idempotency_key = @idempotency_key;

-- name: LockMediaJob :one
SELECT * FROM media_job WHERE workspace_id = @workspace_id AND id = @id FOR UPDATE;

-- name: ListMediaJobAttempts :many
SELECT * FROM media_job_attempt WHERE workspace_id = @workspace_id AND job_id = @job_id ORDER BY fence;

-- name: GetMediaJobAttempt :one
SELECT * FROM media_job_attempt WHERE workspace_id = @workspace_id AND id = @id;

-- name: CreateAttachmentUpload :one
INSERT INTO attachment_upload (workspace_id, initiating_principal_type, initiating_principal_id, purpose,
 idempotency_key, request_hash, job_id, attempt_id, fence, output_index, filename, content_type, size_bytes,
 sha256, part_size, object_key, storage_upload_id, expires_at)
VALUES (@workspace_id, @initiating_principal_type, @initiating_principal_id, @purpose,
 @idempotency_key, @request_hash, @job_id, @attempt_id, @fence, @output_index, @filename, @content_type, @size_bytes,
 @sha256, @part_size, @object_key, @storage_upload_id, @expires_at)
ON CONFLICT DO NOTHING RETURNING *;

-- name: GetAttachmentUpload :one
SELECT * FROM attachment_upload WHERE workspace_id = @workspace_id AND id = @id;

-- name: GetAttachmentUploadByIdempotencyKey :one
SELECT * FROM attachment_upload WHERE workspace_id = @workspace_id AND initiating_principal_type = @initiating_principal_type
 AND initiating_principal_id = @initiating_principal_id AND idempotency_key = @idempotency_key;

-- name: LockAttachmentUpload :one
SELECT * FROM attachment_upload WHERE workspace_id = @workspace_id AND id = @id FOR UPDATE;

-- name: InsertAttachmentUploadPart :one
-- The caller holds the session lock and validates the exact part range and
-- durable object. Conflicting bytes return no row, never overwrite a part.
INSERT INTO attachment_upload_part (workspace_id, upload_id, part_index, size_bytes, sha256, object_key, storage_etag)
VALUES (@workspace_id, @upload_id, @part_index, @size_bytes, @sha256, @object_key, @storage_etag)
ON CONFLICT (workspace_id, upload_id, part_index) DO UPDATE SET sha256 = attachment_upload_part.sha256
WHERE attachment_upload_part.sha256 = EXCLUDED.sha256 AND attachment_upload_part.size_bytes = EXCLUDED.size_bytes
RETURNING *;

-- name: ListAttachmentUploadParts :many
SELECT * FROM attachment_upload_part WHERE workspace_id = @workspace_id AND upload_id = @upload_id
 AND part_index >= @from_index ORDER BY part_index LIMIT @page_size;
