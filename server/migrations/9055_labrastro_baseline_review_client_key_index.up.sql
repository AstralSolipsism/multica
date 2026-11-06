CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_review_client_key ON project_baseline_review (workspace_id, project_id, client_key);
