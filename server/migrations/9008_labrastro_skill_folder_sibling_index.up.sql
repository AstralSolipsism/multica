CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_skill_folder_sibling ON labrastro_skill_folder (workspace_id,parent_id,name) NULLS NOT DISTINCT;
