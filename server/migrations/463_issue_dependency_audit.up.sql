CREATE TABLE IF NOT EXISTS issue_dependency_audit (
    id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    actor_id UUID,
    credential_kind TEXT NOT NULL,
    action TEXT NOT NULL,
    before_state JSONB NOT NULL,
    after_state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
