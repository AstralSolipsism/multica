CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_file_candidate_list ON project_file_candidate (workspace_id, project_id, file_id, id) WHERE resolved_at IS NULL;
