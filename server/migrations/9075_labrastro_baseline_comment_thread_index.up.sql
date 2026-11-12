CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_comment_thread ON project_baseline_comment (workspace_id, project_id, thread_id, created_at, id);
