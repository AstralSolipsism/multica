-- OL-1427: an engineering-baseline wiki page owns rendered artifacts (the
-- compiled LikeC4 single-file canvas) as attachments. The page body keeps only
-- the Markdown source and a ```html src="architecture.html" fence, so the
-- interactive canvas never counts against the 64 KiB body limit and never
-- reaches `baseline get`.
--
-- Attachment rows are bound to the page (and, for traceability, the revision
-- that was current when the file was uploaded). Same-filename resolution
-- mirrors Issue/Chat: the newest upload for the page wins. Ownership is
-- validated in application code; no foreign keys (repo migration rule).
ALTER TABLE attachment
    ADD COLUMN baseline_page_id UUID,
    ADD COLUMN baseline_revision_id UUID;
