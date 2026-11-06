CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_review_batch ON project_baseline_review (workspace_id, batch_id, created_at);
