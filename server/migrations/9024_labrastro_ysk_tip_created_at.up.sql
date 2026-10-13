-- Tip reports insert several rows in one transaction; now() is fixed per
-- transaction, so the batch's created_at collapsed to one instant and the
-- mod's generation order was lost (id DESC fallback is random with uuid v4).
-- clock_timestamp() advances per statement, keeping the insert order.
ALTER TABLE labrastro_issue_tip ALTER COLUMN created_at SET DEFAULT clock_timestamp();
