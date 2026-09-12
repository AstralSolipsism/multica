-- OL-49: preserve the full upstream migration identity, but do not infer a
-- legacy trigger's execution authority from its autopilot's creator. That
-- member need not have created or authorized this trigger. Migration 449's
-- earlier publisher backfill stays intact; unresolved triggers still fail
-- closed and require explicit recreation by an authorized member.
-- This migration updates documentation only and never rewrites principals.
COMMENT ON COLUMN autopilot_trigger.created_by_type IS
    'Actor type of created_by_id: member | agent. Only ''member'' yields a run principal. NULL for a legacy trigger without a recoverable principal from migration 449; Labrastro does not infer one from the autopilot creator.';

COMMENT ON COLUMN autopilot_trigger.created_by_id IS
    'The member a schedule/webhook run fires AS: dispatch admission, originator/accountable and delegated runs use this human. Written at creation for new triggers; legacy values may have been inferred once from the last publisher by migration 449, not proof of the original creator. Ordinary edits never rewrite it. NULL means no principal and dispatch fails closed. No FK; workspace membership is re-validated on every dispatch.';
