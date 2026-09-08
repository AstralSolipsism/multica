CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_file_operation_scope ON project_file_operation (workspace_id, project_id, actor_type, actor_id, operation_key);
