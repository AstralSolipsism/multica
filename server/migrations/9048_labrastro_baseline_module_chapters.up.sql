ALTER TABLE IF EXISTS project_baseline_doc
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

ALTER TABLE IF EXISTS project_baseline_doc
    DROP CONSTRAINT IF EXISTS project_baseline_doc_chapter_check,
    ADD CONSTRAINT project_baseline_doc_chapter_check CHECK (
        chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks')
        OR chapter ~ '^module:[a-z0-9][a-z0-9_-]{0,62}$'
    );

ALTER TABLE IF EXISTS project_baseline_revision
    DROP CONSTRAINT IF EXISTS project_baseline_revision_chapter_check,
    ADD CONSTRAINT project_baseline_revision_chapter_check CHECK (
        chapter IN ('overview', 'domain_rules', 'architecture', 'exclusions_and_risks')
        OR chapter ~ '^module:[a-z0-9][a-z0-9_-]{0,62}$'
    );

