CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_media_attempt_fence ON media_job_attempt (workspace_id, job_id, fence);
