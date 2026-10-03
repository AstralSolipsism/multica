CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_skill_package_source ON labrastro_skill_package (workspace_id,owner_repo,subdirectory);
