CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_skill_placement_source ON labrastro_skill_placement (workspace_id,package_id,source_path);
