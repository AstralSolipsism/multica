-- Synthetic post-upgrade data, after v061-upgrade-seed.sql and migration up.
-- Apply once to the disposable rehearsal database only.
\set ON_ERROR_STOP on
BEGIN;
UPDATE workspace SET settings=jsonb_set(settings,'{pr_merge_status}','"in_review"') WHERE slug='ol98-disabled';
UPDATE issue_wakeup SET condition='{"kind":"issue_status","status":"done"}', max_fires=3,fire_count=1,paused_reason='max_fires' WHERE id='98000000-0000-4000-8000-000000000010';
INSERT INTO issue_wakeup(id,workspace_id,issue_id,instruction,kind,mode,system_rule) VALUES ('98000000-0000-4000-8000-000000000011','98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000004','System wakeup','event','continuous','child_done');
INSERT INTO issue_wakeup_receipt(id,wakeup_id,revision,event_key,event_type,payload) VALUES ('98000000-0000-4000-8000-000000000021','98000000-0000-4000-8000-000000000011',1,'upgrade-test','issue.updated','{}');
UPDATE issue SET status='done' WHERE id='98000000-0000-4000-8000-000000000005';
COMMIT;
