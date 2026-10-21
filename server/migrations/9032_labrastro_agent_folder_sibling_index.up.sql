CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_agent_folder_sibling ON labrastro_agent_folder (workspace_id, parent_id, name) NULLS NOT DISTINCT;
