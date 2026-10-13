-- Tip reports insert several rows in one transaction; now() is fixed per
-- transaction, so the batch's created_at collapsed to one instant and the
-- mod's generation order was lost (id DESC fallback is random with uuid v4).
-- clock_timestamp() advances per statement, keeping the insert order.
-- updated_at follows suit so a fresh row is not stamped 4-5 ms before it was
-- created (now() is the transaction start, which includes lock waits).
ALTER TABLE labrastro_issue_tip ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE labrastro_issue_tip ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
