CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_thread_page ON project_baseline_thread (workspace_id, project_id, page_id, updated_at DESC, id);
