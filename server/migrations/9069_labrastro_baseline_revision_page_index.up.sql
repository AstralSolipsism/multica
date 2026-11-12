CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_baseline_revision_page ON project_baseline_revision (page_id, revision_number);
