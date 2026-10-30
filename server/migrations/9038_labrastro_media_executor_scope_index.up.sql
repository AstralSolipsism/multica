CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_media_executor_scope ON media_executor (workspace_id, daemon_id, credential_scope_id);
