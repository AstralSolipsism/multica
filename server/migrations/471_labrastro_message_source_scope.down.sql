-- A downgrade withdraws the new scope before removing its representation.
-- History survives this step; 467 down explicitly removes all non-run data.
UPDATE labrastro_message_approved_target
SET revoked_at = now()
WHERE source_kind IN ('activity', 'comment') AND revoked_at IS NULL;
UPDATE labrastro_message_route
SET enabled = false, revision = revision + 1, updated_at = now()
WHERE source_kind <> 'run' AND enabled;
UPDATE labrastro_message_delivery
SET status = 'cancelled', error_code = 'route_authorization_lost',
    last_error = 'source scope downgraded', lease_token = NULL,
    lease_expires_at = NULL, updated_at = now()
WHERE autopilot_id IS NULL AND status IN ('queued', 'sending', 'failed', 'uncertain');
ALTER TABLE labrastro_message_delivery
    DROP CONSTRAINT labrastro_message_delivery_scope_shape,
    DROP CONSTRAINT labrastro_message_delivery_scope_known,
    DROP COLUMN source_scope,
    DROP COLUMN source_project_id;
ALTER TABLE labrastro_message_approved_target
    DROP CONSTRAINT labrastro_message_approved_target_project_shape,
    DROP COLUMN project_id;
ALTER TABLE labrastro_message_route DROP COLUMN last_disabled_at;
