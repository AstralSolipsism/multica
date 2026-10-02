\set ON_ERROR_STOP on
DO $$ BEGIN
 IF (SELECT settings->>'pr_merge_status' FROM workspace WHERE slug='ol98-disabled') IS DISTINCT FROM 'in_review'
 OR NOT EXISTS (SELECT 1 FROM issue_wakeup WHERE id='98000000-0000-4000-8000-000000000010' AND condition IS NOT NULL AND max_fires=3 AND fire_count=1 AND paused_reason='max_fires')
 OR NOT EXISTS (SELECT 1 FROM issue_wakeup WHERE id='98000000-0000-4000-8000-000000000011' AND system_rule='child_done')
 OR NOT EXISTS (SELECT 1 FROM issue_wakeup_receipt WHERE id='98000000-0000-4000-8000-000000000021')
 OR NOT EXISTS (SELECT 1 FROM issue_child_event WHERE child_id='98000000-0000-4000-8000-000000000005')
 THEN RAISE EXCEPTION 'Post-upgrade backup did not restore all destructive-down data'; END IF;
END $$;
SELECT 'Post-upgrade restore preserves PR setting, system wakeup and receipt, condition/counters/pause, child events' AS result;
