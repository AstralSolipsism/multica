-- One route per (workspace, source automation, bot, normalized target):
-- saving an equivalent route twice is a conflict the API reports instead of
-- a silent duplicate that would double-send.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_route_identity
    ON labrastro_message_route(workspace_id, autopilot_id, installation_id, target_key);
