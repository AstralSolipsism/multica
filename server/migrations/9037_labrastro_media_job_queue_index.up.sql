CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_media_job_queue ON media_job (workspace_id, state, created_at);
