CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attachment_baseline_page
    ON attachment (baseline_page_id)
    WHERE baseline_page_id IS NOT NULL;
