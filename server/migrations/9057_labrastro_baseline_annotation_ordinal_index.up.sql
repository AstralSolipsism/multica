CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_annotation_ordinal ON project_baseline_annotation (workspace_id, batch_id, ordinal);
