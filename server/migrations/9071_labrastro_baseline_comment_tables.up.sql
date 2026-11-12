CREATE TABLE IF NOT EXISTS project_baseline_thread (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    page_id UUID NOT NULL,
    anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('text', 'section')),
    section_anchor TEXT NOT NULL CHECK (char_length(section_anchor) BETWEEN 1 AND 300),
    section_title TEXT NOT NULL DEFAULT '',
    quote_exact TEXT NOT NULL DEFAULT '' CHECK (char_length(quote_exact) <= 500),
    quote_prefix TEXT NOT NULL DEFAULT '' CHECK (char_length(quote_prefix) <= 64),
    quote_suffix TEXT NOT NULL DEFAULT '' CHECK (char_length(quote_suffix) <= 64),
    quote_start INTEGER CHECK (quote_start >= 0),
    anchor_revision_number INTEGER,
    issue_id UUID,
    resolved_at TIMESTAMPTZ,
    resolved_by_type TEXT CHECK (resolved_by_type IN ('member', 'agent')),
    resolved_by_id UUID,
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member', 'agent')),
    created_by_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (anchor_kind <> 'text' OR quote_exact <> ''),
    CHECK ((resolved_at IS NULL) = (resolved_by_type IS NULL)),
    CHECK ((resolved_by_type IS NULL) = (resolved_by_id IS NULL))
);

CREATE TABLE IF NOT EXISTS project_baseline_comment (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    project_id UUID NOT NULL,
    thread_id UUID NOT NULL,
    body_markdown TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 1 AND 4000),
    author_type TEXT NOT NULL CHECK (author_type IN ('member', 'agent')),
    author_id UUID NOT NULL,
    author_task_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ
);
