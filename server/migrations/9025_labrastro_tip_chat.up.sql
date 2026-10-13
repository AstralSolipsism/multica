-- Private side-chat provenance. Soft references follow the fork's application
-- cleanup protocol; snapshots remain stable for the lifetime of a conversation.
CREATE TABLE labrastro_tip_chat (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    tip_id uuid NOT NULL,
    chat_session_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    source_task_id uuid NOT NULL,
    issue_identifier text NOT NULL,
    tip_snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
