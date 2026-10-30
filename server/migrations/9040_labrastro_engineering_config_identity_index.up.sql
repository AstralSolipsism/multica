CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_engineering_identity ON project_engineering (workspace_id, project_id);
