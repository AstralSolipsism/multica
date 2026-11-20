ALTER TABLE attachment
    DROP COLUMN IF EXISTS baseline_revision_id,
    DROP COLUMN IF EXISTS baseline_page_id;
