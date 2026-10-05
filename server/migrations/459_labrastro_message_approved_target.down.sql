-- Destructive: deletes approved targets and their consent/audit history.
-- Reapplying up creates an empty table; it cannot reconstruct prior approvals.
-- Stop delivery workers and preserve a backup before an intentional rollback.
DROP TABLE IF EXISTS labrastro_message_approved_target;
