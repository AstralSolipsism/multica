-- Revoke project grants before any downgrade DDL: the preview index cannot
-- represent multiple active project grants to the same target. No rows or
-- indexes are removed when this precondition is unmet.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM labrastro_message_approved_target
               WHERE project_id IS NOT NULL AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'revoke project message target approvals before downgrading source scopes';
    END IF;
END $$;
DROP INDEX IF EXISTS uq_labrastro_message_approved_target_project_active;
