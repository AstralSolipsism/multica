CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_annotation_active ON project_baseline_annotation_batch (workspace_id, project_id, chapter) WHERE closed_at IS NULL;
