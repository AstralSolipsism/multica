-- Rebuild the pre-wiki baseline shapes so the previous binary can start after a
-- rollback. The up migration wiped test-only baseline rows and dropped the
-- annotation tables; neither the data nor the annotation-table rows are
-- restored here. Wiki-era rows created after 9067 are not representable in the
-- old schema: they keep chapter 'overview' and status 'adopted' defaults.
BEGIN;

ALTER TABLE project_baseline_page RENAME TO project_baseline_doc;
ALTER TABLE project_baseline_doc RENAME COLUMN current_revision_id TO adopted_revision_id;
ALTER TABLE project_baseline_doc DROP CONSTRAINT IF EXISTS project_baseline_page_parent_check;
ALTER TABLE project_baseline_doc DROP CONSTRAINT IF EXISTS project_baseline_page_slug_check;
ALTER TABLE project_baseline_doc DROP CONSTRAINT IF EXISTS project_baseline_page_title_check;
ALTER TABLE project_baseline_doc DROP COLUMN parent_id;
ALTER TABLE project_baseline_doc DROP COLUMN slug;
ALTER TABLE project_baseline_doc DROP COLUMN last_revision_number;
ALTER TABLE project_baseline_doc DROP COLUMN archived_at;
ALTER TABLE project_baseline_doc ALTER COLUMN title SET DEFAULT '';
ALTER TABLE project_baseline_doc ADD COLUMN chapter TEXT NOT NULL DEFAULT 'overview';
ALTER TABLE project_baseline_doc
    ADD CONSTRAINT project_baseline_doc_chapter_check CHECK (
        chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks')
        OR chapter ~ '^module:[a-z0-9][a-z0-9_-]{0,62}$'
    );
ALTER TABLE project_baseline_doc ADD COLUMN candidate_revision_id UUID;

ALTER TABLE project_baseline_revision DROP CONSTRAINT IF EXISTS project_baseline_revision_kind_check;
ALTER TABLE project_baseline_revision DROP CONSTRAINT IF EXISTS project_baseline_revision_slug_check;
ALTER TABLE project_baseline_revision DROP CONSTRAINT IF EXISTS project_baseline_revision_title_check;
ALTER TABLE project_baseline_revision DROP COLUMN page_id;
ALTER TABLE project_baseline_revision DROP COLUMN revision_kind;
ALTER TABLE project_baseline_revision DROP COLUMN title;
ALTER TABLE project_baseline_revision DROP COLUMN slug;
ALTER TABLE project_baseline_revision DROP COLUMN parent_id;
ALTER TABLE project_baseline_revision DROP COLUMN position;
ALTER TABLE project_baseline_revision DROP COLUMN archived_at;
ALTER TABLE project_baseline_revision DROP COLUMN restored_from_revision_id;
ALTER TABLE project_baseline_revision ADD COLUMN chapter TEXT NOT NULL DEFAULT 'overview';
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_chapter_check CHECK (
        chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks')
        OR chapter ~ '^module:[a-z0-9][a-z0-9_-]{0,62}$'
    );
ALTER TABLE project_baseline_revision ADD COLUMN status TEXT NOT NULL DEFAULT 'adopted';
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_status_check CHECK (
        status IN ('candidate', 'adopted', 'superseded', 'withdrawn', 'rejected')
    );
ALTER TABLE project_baseline_revision ADD COLUMN replaces_revision_id UUID;
ALTER TABLE project_baseline_revision ADD COLUMN anchors_diff JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE project_baseline_revision ADD COLUMN decided_by_type TEXT;
ALTER TABLE project_baseline_revision ADD COLUMN decided_by_id UUID;
ALTER TABLE project_baseline_revision ADD COLUMN decided_by_task_id UUID;
ALTER TABLE project_baseline_revision ADD COLUMN decided_at TIMESTAMPTZ;
ALTER TABLE project_baseline_revision ADD COLUMN decision_credential TEXT;

-- Minimal empty skeletons of the three annotation tables dropped by the up
-- migration (9059 shapes without data or their 9060-9063 indexes).
CREATE TABLE IF NOT EXISTS project_baseline_annotation_batch (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL, project_id UUID NOT NULL,
  chapter TEXT NOT NULL,
  carrier_kind TEXT NOT NULL CONSTRAINT annotation_batch_skeleton_carrier CHECK (carrier_kind IN ('revision_issue','source_issue')),
  issue_id UUID,
  agent_id UUID NOT NULL,
  created_by_type TEXT NOT NULL CONSTRAINT annotation_batch_skeleton_creator CHECK (created_by_type = 'member'), created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ, close_reason TEXT CONSTRAINT annotation_batch_skeleton_reason CHECK (close_reason IN ('adopted','rejected','manual','issue_closed')),
  closed_by_type TEXT, closed_by_id UUID, closed_revision_id UUID,
  CONSTRAINT annotation_batch_skeleton_close CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE TABLE IF NOT EXISTS project_baseline_review (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL, project_id UUID NOT NULL, batch_id UUID NOT NULL,
  client_key UUID NOT NULL,
  reviewed_revision_id UUID NOT NULL,
  summary TEXT NOT NULL DEFAULT '' CONSTRAINT annotation_review_skeleton_summary CHECK (char_length(summary) <= 500),
  wake_comment_id UUID,
  created_by_type TEXT NOT NULL CONSTRAINT annotation_review_skeleton_creator CHECK (created_by_type = 'member'), created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_baseline_annotation (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL, project_id UUID NOT NULL, batch_id UUID NOT NULL, review_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CONSTRAINT annotation_skeleton_ordinal CHECK (ordinal BETWEEN 1 AND 50),
  parent_annotation_id UUID,
  anchor_kind TEXT NOT NULL CONSTRAINT annotation_skeleton_kind CHECK (anchor_kind IN ('text','lines','section')),
  target_revision_id UUID NOT NULL, target_revision_number INTEGER NOT NULL,
  section_anchor TEXT NOT NULL CONSTRAINT annotation_skeleton_section CHECK (char_length(section_anchor) BETWEEN 1 AND 300),
  section_title TEXT NOT NULL DEFAULT '',
  line_start INTEGER, line_end INTEGER,
  quote TEXT NOT NULL DEFAULT '' CONSTRAINT annotation_skeleton_quote CHECK (char_length(quote) <= 500),
  prefix TEXT NOT NULL DEFAULT '' CONSTRAINT annotation_skeleton_prefix CHECK (char_length(prefix) <= 64),
  suffix TEXT NOT NULL DEFAULT '' CONSTRAINT annotation_skeleton_suffix CHECK (char_length(suffix) <= 64),
  start INTEGER NOT NULL DEFAULT 0 CONSTRAINT annotation_skeleton_start CHECK (start >= 0),
  note TEXT NOT NULL CONSTRAINT annotation_skeleton_note CHECK (char_length(note) BETWEEN 1 AND 1000),
  response TEXT CONSTRAINT annotation_skeleton_response CHECK (char_length(response) <= 1000), responded_at TIMESTAMPTZ, responded_by_task_id UUID,
  created_by_type TEXT NOT NULL, created_by_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ, resolved_by_type TEXT, resolved_by_id UUID,
  CONSTRAINT annotation_skeleton_response_time CHECK ((response IS NULL) = (responded_at IS NULL))
);

COMMIT;
