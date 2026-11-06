CREATE TABLE IF NOT EXISTS project_baseline_annotation_batch (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL, project_id UUID NOT NULL,
  chapter TEXT NOT NULL CHECK (chapter IN ('overview','domain_rules','architecture','exclusions_and_risks')
                               OR chapter ~ '^module:[a-z0-9][a-z0-9_-]{0,62}$'),
  carrier_kind TEXT NOT NULL CHECK (carrier_kind IN ('revision_issue','source_issue')),
  issue_id UUID,
  agent_id UUID NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type = 'member'), created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ, close_reason TEXT CHECK (close_reason IN ('adopted','rejected','manual','issue_closed')),
  closed_by_type TEXT, closed_by_id UUID, closed_revision_id UUID,
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE TABLE IF NOT EXISTS project_baseline_review (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL, project_id UUID NOT NULL, batch_id UUID NOT NULL,
  client_key UUID NOT NULL,
  reviewed_revision_id UUID NOT NULL,
  summary TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 500),
  wake_comment_id UUID,
  created_by_type TEXT NOT NULL CHECK (created_by_type = 'member'), created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_baseline_annotation (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL, project_id UUID NOT NULL, batch_id UUID NOT NULL, review_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 50),
  parent_annotation_id UUID,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('text','lines','section')),
  target_revision_id UUID NOT NULL, target_revision_number INTEGER NOT NULL,
  section_anchor TEXT NOT NULL CHECK (char_length(section_anchor) BETWEEN 1 AND 300),
  section_title TEXT NOT NULL DEFAULT '',
  line_start INTEGER, line_end INTEGER,
  quote TEXT NOT NULL DEFAULT '' CHECK (char_length(quote) <= 500),
  prefix TEXT NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 64),
  suffix TEXT NOT NULL DEFAULT '' CHECK (char_length(suffix) <= 64),
  start INTEGER NOT NULL DEFAULT 0 CHECK (start >= 0),
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  response TEXT CHECK (char_length(response) <= 1000), responded_at TIMESTAMPTZ, responded_by_task_id UUID,
  created_by_type TEXT NOT NULL, created_by_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ, resolved_by_type TEXT, resolved_by_id UUID,
  CHECK ((anchor_kind = 'lines') = (line_start IS NOT NULL AND line_end IS NOT NULL)),
  CHECK (line_start IS NULL OR (line_start >= 1 AND line_end >= line_start AND line_end - line_start < 50)),
  CHECK ((response IS NULL) = (responded_at IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by_id IS NULL) AND (resolved_at IS NULL) = (resolved_by_type IS NULL))
);
