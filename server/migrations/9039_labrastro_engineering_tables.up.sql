CREATE TABLE IF NOT EXISTS project_engineering (
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    current_stage INTEGER NOT NULL DEFAULT 1 CHECK (current_stage >= 1),
    mode_summary TEXT NOT NULL DEFAULT '' CHECK (char_length(mode_summary) <= 280),
    decider_member_ids UUID[] NOT NULL DEFAULT '{}',
    agent_decisions_enabled BOOLEAN NOT NULL DEFAULT false,
    updated_by_type TEXT NOT NULL CHECK (updated_by_type IN ('member', 'agent')),
    updated_by_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_baseline_doc (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    chapter TEXT NOT NULL CHECK (chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks')),
    adopted_revision_id UUID,
    candidate_revision_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_baseline_revision (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    chapter TEXT NOT NULL CHECK (chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks')),
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'adopted', 'superseded', 'withdrawn', 'rejected')),
    content_markdown TEXT NOT NULL CHECK (octet_length(content_markdown) <= 65536),
    change_summary TEXT NOT NULL CHECK (char_length(change_summary) <= 500),
    base_revision_id UUID,
    replaces_revision_id UUID,
    anchors_diff JSONB NOT NULL,
    source_issue_id UUID,
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member', 'agent')),
    created_by_id UUID NOT NULL,
    created_by_task_id UUID,
    decided_by_type TEXT CHECK (decided_by_type IN ('member', 'agent')),
    decided_by_id UUID,
    decided_by_task_id UUID,
    decided_at TIMESTAMPTZ,
    decision_credential TEXT CHECK (decision_credential IN ('session', 'pat', 'task')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
