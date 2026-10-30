CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_baseline_revision_number ON project_baseline_revision (workspace_id, project_id, chapter, revision_number);
