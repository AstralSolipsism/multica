CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_baseline_revision_activity ON project_baseline_revision (workspace_id, project_id, created_at DESC);
