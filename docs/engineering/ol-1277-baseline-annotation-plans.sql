-- Run with psql -X -v ON_ERROR_STOP=1 -f this-file against a migrated disposable DB.
-- All fixture tables are temporary; no application rows or indexes are changed.
BEGIN;
CREATE TEMP TABLE project_baseline_annotation_batch
  (LIKE public.project_baseline_annotation_batch INCLUDING ALL);
CREATE TEMP TABLE project_baseline_review
  (LIKE public.project_baseline_review INCLUDING ALL);
CREATE TEMP TABLE project_baseline_annotation
  (LIKE public.project_baseline_annotation INCLUDING ALL);

INSERT INTO project_baseline_annotation_batch
  (id,workspace_id,project_id,chapter,carrier_kind,agent_id,created_by_type,created_by_id,closed_at,close_reason)
SELECT md5('batch'||g)::uuid, md5('workspace')::uuid,
  md5(CASE WHEN g<=10000 THEN 'project' ELSE 'other' END)::uuid,
  'domain_rules','revision_issue',md5('agent')::uuid,'member',md5('member')::uuid,now(),'manual'
FROM generate_series(1,20000) g;
INSERT INTO project_baseline_annotation_batch
  (id,workspace_id,project_id,chapter,carrier_kind,agent_id,created_by_type,created_by_id)
VALUES (md5('active')::uuid,md5('workspace')::uuid,md5('project')::uuid,
  'domain_rules','revision_issue',md5('agent')::uuid,'member',md5('member')::uuid);
INSERT INTO project_baseline_review
  (id,workspace_id,project_id,batch_id,client_key,reviewed_revision_id,created_by_type,created_by_id)
SELECT md5('review'||g)::uuid,md5('workspace')::uuid,md5('project')::uuid,
  md5('batch'||g)::uuid,md5('key'||g)::uuid,md5('revision')::uuid,'member',md5('member')::uuid
FROM generate_series(1,20000) g;
INSERT INTO project_baseline_annotation
  (id,workspace_id,project_id,batch_id,review_id,ordinal,anchor_kind,target_revision_id,
   target_revision_number,section_anchor,note,created_by_type,created_by_id)
SELECT md5('annotation'||g)::uuid,md5('workspace')::uuid,md5('project')::uuid,
  md5('batch'||g)::uuid,md5('review'||g)::uuid,1,'section',md5('revision')::uuid,
  1,'RULE-1','fixture','member',md5('member')::uuid FROM generate_series(1,20000) g;
ANALYZE project_baseline_annotation_batch;
ANALYZE project_baseline_review;
ANALYZE project_baseline_annotation;

\echo 'Original submission: history list'
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM project_baseline_annotation_batch
WHERE workspace_id=md5('workspace')::uuid AND project_id=md5('project')::uuid ORDER BY created_at,id;
\echo 'Scoped submission: active chapter'
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM project_baseline_annotation_batch
WHERE workspace_id=md5('workspace')::uuid AND project_id=md5('project')::uuid
AND chapter='domain_rules' AND closed_at IS NULL;
\echo 'Annotation identity lookup: remaining index gap'
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM project_baseline_annotation WHERE workspace_id=md5('workspace')::uuid
AND project_id=md5('project')::uuid AND id=md5('annotation10000')::uuid;
\echo 'Related batch closure: scoped EXISTS (fixture rollback)'
EXPLAIN (ANALYZE, BUFFERS)
UPDATE project_baseline_annotation_batch b SET closed_at=now(),close_reason='adopted',
closed_by_type='member',closed_by_id=md5('member')::uuid,closed_revision_id=md5('revision')::uuid
WHERE b.workspace_id=md5('workspace')::uuid AND b.project_id=md5('project')::uuid
AND b.chapter='domain_rules' AND b.closed_at IS NULL
AND (b.issue_id=md5('issue')::uuid OR EXISTS (
SELECT 1 FROM project_baseline_review r WHERE r.workspace_id=b.workspace_id
AND r.project_id=b.project_id AND r.batch_id=b.id AND r.reviewed_revision_id=md5('revision')::uuid))
RETURNING b.*;
ROLLBACK;
