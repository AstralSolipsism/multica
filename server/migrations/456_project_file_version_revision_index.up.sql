CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_file_version_revision ON project_file_version (workspace_id, project_id, file_id, revision) WHERE revision IS NOT NULL;
