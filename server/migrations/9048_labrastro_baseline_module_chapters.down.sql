-- Refuse a rollback that would discard dynamic chapters or their audit history.
DO $$
BEGIN
    IF to_regclass('project_baseline_doc') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM project_baseline_doc WHERE chapter LIKE 'module:%') THEN
            RAISE EXCEPTION 'Cannot roll back module chapters while project_baseline_doc contains module data';
        END IF;
    END IF;
    IF to_regclass('project_baseline_revision') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM project_baseline_revision WHERE chapter LIKE 'module:%') THEN
            RAISE EXCEPTION 'Cannot roll back module chapters while project_baseline_revision contains module data';
        END IF;
    END IF;
END $$;

ALTER TABLE IF EXISTS project_baseline_doc
    DROP CONSTRAINT IF EXISTS project_baseline_doc_chapter_check,
    ADD CONSTRAINT project_baseline_doc_chapter_check CHECK (chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks'));

ALTER TABLE IF EXISTS project_baseline_revision
    DROP CONSTRAINT IF EXISTS project_baseline_revision_chapter_check,
    ADD CONSTRAINT project_baseline_revision_chapter_check CHECK (chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks'));

ALTER TABLE IF EXISTS project_baseline_doc
    DROP COLUMN IF EXISTS title,
    DROP COLUMN IF EXISTS position;
