CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_media_attempt_active ON media_job_attempt (workspace_id, job_id) WHERE closed_at IS NULL;
