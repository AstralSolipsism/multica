CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_baseline_doc_chapter ON project_baseline_doc (workspace_id, project_id, chapter);
