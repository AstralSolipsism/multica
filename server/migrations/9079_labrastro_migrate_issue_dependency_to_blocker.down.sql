-- Nothing to undo. The blockers 9079 wrote are ordinary manual issue_blocker
-- rows, indistinguishable from ones added since; rolling back past 743 drops
-- the table with them. issue_dependency was never changed, so its historical
-- rows are still there.
SELECT 1;
