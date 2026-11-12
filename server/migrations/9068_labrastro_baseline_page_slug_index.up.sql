CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_baseline_page_slug ON project_baseline_page (workspace_id, project_id, slug);
