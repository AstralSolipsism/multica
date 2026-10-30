CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_media_executor_identity ON media_executor (workspace_id, executor_id);
