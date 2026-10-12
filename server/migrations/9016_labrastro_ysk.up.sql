-- YSK is a human-facing side channel. No prompt, comment, or task-message data
-- is stored here. Relationships are checked and cleaned up by the application.
CREATE TABLE labrastro_issue_tip (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    task_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    anchor_comment_id uuid,
    tag text NOT NULL CHECK (tag IN ('you_should_know', 'heads_up')),
    line text NOT NULL CHECK (char_length(line) BETWEEN 1 AND 40),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 12),
    explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'overturned', 'source_changed')),
    overturned_by_task_id uuid,
    overturned_by_comment_id uuid,
    overturned_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE labrastro_issue_tip_state (
    workspace_id uuid NOT NULL,
    tip_id uuid NOT NULL,
    user_id uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('known', 'dismissed')),
    feedback text CHECK (feedback IN ('helpful', 'not_relevant', 'not_understood')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE labrastro_known_topic (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 40),
    updated_at timestamptz NOT NULL DEFAULT now()
);
