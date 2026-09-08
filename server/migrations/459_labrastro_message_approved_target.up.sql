-- OL-25 repair contract §2 (review R1): workspace-approved external delivery
-- targets. A group/topic route may only be saved and executed when the
-- normalized target (workspace + autopilot + installation + target_key) has
-- an ACTIVE approval by a workspace owner/admin. The autopilot dimension is
-- part of the approval scope deliberately: approving "automation A may share
-- results to this chat" is NOT a workspace-wide grant other automations can
-- borrow. Member targets stay out of this table — their binding proves
-- address ownership and the route authorizer's source permission covers the
-- sharing decision; the reviewer contract pins that distinction.
--
-- No foreign keys by house rule; approver membership and installation state
-- are re-validated in application code. revoked_at keeps the audit trail: a
-- revoked approval never satisfies the active check (the partial unique
-- index covers only unrevoked rows), and re-approving inserts a fresh row.
CREATE TABLE labrastro_message_approved_target (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL,
    autopilot_id    UUID NOT NULL,
    installation_id UUID NOT NULL,
    target_key      TEXT NOT NULL,
    target_type     TEXT NOT NULL
        CHECK (target_type IN ('group', 'topic')),
    approved_by     UUID NOT NULL,
    approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

-- indexes for the table live in 460 (single-statement concurrent contract).
