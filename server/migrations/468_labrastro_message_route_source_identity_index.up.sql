-- OL-27: identity for personal/team routes. The OL-25 identity index
-- (workspace, autopilot, installation, target) cannot cover non-run routes
-- (autopilot_id is NULL there). NULLS NOT DISTINCT makes an exact duplicate
-- (same scope kind, project filter and event filter) a 23505 conflict the
-- API reports, instead of a silent second rule that could double-decide
-- nothing but confuse the config surface — delivery correctness is carried
-- by the decision dedup key either way.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_labrastro_message_route_source_identity
    ON labrastro_message_route (workspace_id, source_kind, installation_id, target_key, project_id, event_types)
    NULLS NOT DISTINCT
    WHERE source_kind <> 'run';
