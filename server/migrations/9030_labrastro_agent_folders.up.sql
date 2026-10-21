-- Relationships are validated and cleaned up transactionally by the handlers.
CREATE TABLE IF NOT EXISTS labrastro_agent_folder (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    parent_id UUID,
    name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id IS DISTINCT FROM parent_id)
);
CREATE TABLE IF NOT EXISTS labrastro_agent_placement (
    workspace_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    folder_id UUID NOT NULL
);
CREATE TABLE IF NOT EXISTS labrastro_agent_squad_placement (
    workspace_id UUID NOT NULL,
    squad_id UUID NOT NULL,
    folder_id UUID NOT NULL
);
