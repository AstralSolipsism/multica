CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_job_queue ON media_job (workspace_id, next_eligible_at, created_at) WHERE state = 'queued';
