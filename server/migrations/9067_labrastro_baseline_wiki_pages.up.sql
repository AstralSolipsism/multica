-- OL-1329: evolve the baseline store into the final tree-wiki schema in one
-- transaction. The workspace owner confirmed every existing baseline was
-- created for testing only, so historical rows are wiped instead of migrated:
-- candidate queues, annotation batches and chapter columns are all retired.
-- project_engineering and its rows are untouched.
BEGIN;

DELETE FROM project_baseline_revision;
DELETE FROM project_baseline_doc;
DROP TABLE IF EXISTS project_baseline_annotation;
DROP TABLE IF EXISTS project_baseline_review;
DROP TABLE IF EXISTS project_baseline_annotation_batch;

ALTER TABLE project_baseline_doc RENAME TO project_baseline_page;
ALTER TABLE project_baseline_page RENAME COLUMN adopted_revision_id TO current_revision_id;
-- Dropping chapter also removes its CHECK constraints plus
-- idx_project_baseline_doc_chapter (9042) and, on the revision table,
-- idx_project_baseline_revision_number (9044) and idx_project_baseline_candidate (9045).
ALTER TABLE project_baseline_page DROP COLUMN chapter;
ALTER TABLE project_baseline_page DROP COLUMN candidate_revision_id;
ALTER TABLE project_baseline_page ADD COLUMN parent_id UUID;
ALTER TABLE project_baseline_page ADD COLUMN slug TEXT NOT NULL;
ALTER TABLE project_baseline_page ADD COLUMN last_revision_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_baseline_page ADD COLUMN archived_at TIMESTAMPTZ;

ALTER TABLE project_baseline_page
    ADD CONSTRAINT project_baseline_page_parent_check CHECK (parent_id IS DISTINCT FROM id);
ALTER TABLE project_baseline_page
    ADD CONSTRAINT project_baseline_page_slug_check CHECK (
        slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
        AND slug !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    );
ALTER TABLE project_baseline_page
    ADD CONSTRAINT project_baseline_page_title_check CHECK (char_length(title) BETWEEN 1 AND 200);
ALTER TABLE project_baseline_page ALTER COLUMN title DROP DEFAULT;
ALTER TABLE project_baseline_page ALTER COLUMN current_revision_id SET NOT NULL;

ALTER TABLE project_baseline_revision DROP COLUMN chapter;
ALTER TABLE project_baseline_revision DROP COLUMN status;
ALTER TABLE project_baseline_revision DROP COLUMN replaces_revision_id;
ALTER TABLE project_baseline_revision DROP COLUMN anchors_diff;
ALTER TABLE project_baseline_revision DROP COLUMN decided_by_type;
ALTER TABLE project_baseline_revision DROP COLUMN decided_by_id;
ALTER TABLE project_baseline_revision DROP COLUMN decided_by_task_id;
ALTER TABLE project_baseline_revision DROP COLUMN decided_at;
ALTER TABLE project_baseline_revision DROP COLUMN decision_credential;
ALTER TABLE project_baseline_revision ADD COLUMN page_id UUID NOT NULL;
ALTER TABLE project_baseline_revision ADD COLUMN revision_kind TEXT NOT NULL DEFAULT 'content';
ALTER TABLE project_baseline_revision ADD COLUMN title TEXT NOT NULL;
ALTER TABLE project_baseline_revision ADD COLUMN slug TEXT NOT NULL;
ALTER TABLE project_baseline_revision ADD COLUMN parent_id UUID;
ALTER TABLE project_baseline_revision ADD COLUMN position INTEGER NOT NULL;
ALTER TABLE project_baseline_revision ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE project_baseline_revision ADD COLUMN restored_from_revision_id UUID;

ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_kind_check CHECK (
        revision_kind IN ('create', 'content', 'rename', 'move', 'archive', 'restore', 'rollback')
    );
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_slug_check CHECK (
        slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
        AND slug !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    );
ALTER TABLE project_baseline_revision
    ADD CONSTRAINT project_baseline_revision_title_check CHECK (char_length(title) BETWEEN 1 AND 200);

COMMIT;
