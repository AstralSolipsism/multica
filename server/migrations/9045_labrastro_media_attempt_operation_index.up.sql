CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_media_attempt_operation ON media_job_attempt (workspace_id, executor_id, operation_id);
