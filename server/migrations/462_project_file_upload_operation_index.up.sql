CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_file_upload_operation ON project_file_upload (workspace_id, project_id, operation_id);
