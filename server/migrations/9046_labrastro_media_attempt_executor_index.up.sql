CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_attempt_executor ON media_job_attempt (workspace_id, executor_id, lease_expires_at) WHERE closed_at IS NULL;
