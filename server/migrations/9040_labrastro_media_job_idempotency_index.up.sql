CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_media_job_idempotency ON media_job (workspace_id, initiating_principal_type, initiating_principal_id, idempotency_key);
