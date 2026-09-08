CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_file_path ON project_file (workspace_id, project_id, path);
