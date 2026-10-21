CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_labrastro_agent_placement_identity ON labrastro_agent_placement (workspace_id, agent_id);
