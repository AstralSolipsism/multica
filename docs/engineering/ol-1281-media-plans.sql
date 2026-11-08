-- Run through scripts/dev-env.sh exec against a migrated disposable database:
-- psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/engineering/ol-1281-media-plans.sql
-- Temporary clones preserve columns/indexes without touching application rows.
CREATE TEMP TABLE media_job (LIKE public.media_job INCLUDING ALL);
CREATE TEMP TABLE agent_runtime (LIKE public.agent_runtime INCLUDING ALL);
CREATE TEMP TABLE member (LIKE public.member INCLUDING ALL);
CREATE TEMP TABLE workspace (LIKE public.workspace INCLUDING ALL);

INSERT INTO workspace(id,name,slug) VALUES
('00000000-0000-0000-0000-000000000001','Media plan fixture','media-plan-fixture');
INSERT INTO member(workspace_id,user_id,role) VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','owner');
INSERT INTO agent_runtime(id,workspace_id,name,runtime_mode,provider,status,daemon_id,owner_id,metadata)
SELECT md5('runtime-'||g)::uuid,'00000000-0000-0000-0000-000000000001',
       'fixture','local','codex','online','daemon-'||g,
       '00000000-0000-0000-0000-000000000002','{"capabilities":["media-image-codex-v1"]}'::jsonb
FROM generate_series(1,100) g;
INSERT INTO media_job(id,workspace_id,caller_id,uploader_type,uploader_id,request,state,created_at,expires_at)
SELECT md5('job-'||g)::uuid,'00000000-0000-0000-0000-000000000001',
       '00000000-0000-0000-0000-000000000002','member','00000000-0000-0000-0000-000000000002',
       '{"provider":"codex","capability":"image-generate","prompt":"fixture"}'::jsonb,
       CASE WHEN g<=100000 THEN 'completed' ELSE 'queued' END,
       now()+g*interval '1 microsecond',now()+interval '30 minutes'
FROM generate_series(1,110000) g;
UPDATE media_job SET state='running',runtime_id=md5('runtime-1')::uuid WHERE id=md5('job-100001')::uuid;
ANALYZE media_job;
ANALYZE agent_runtime;
ANALYZE member;
ANALYZE workspace;

\echo 'CreateMediaJob: bounded authorization CTE'
EXPLAIN (ANALYZE, BUFFERS)
WITH authorized_workspace AS MATERIALIZED (
  SELECT w.id FROM workspace w JOIN member m ON m.workspace_id=w.id
  WHERE w.id='00000000-0000-0000-0000-000000000001'
    AND m.user_id='00000000-0000-0000-0000-000000000002' FOR KEY SHARE OF w,m
)
INSERT INTO media_job(workspace_id,caller_id,uploader_type,uploader_id,request)
SELECT id,'00000000-0000-0000-0000-000000000002','member',
       '00000000-0000-0000-0000-000000000002','{"provider":"codex","capability":"image-generate"}'::jsonb
FROM authorized_workspace RETURNING *;

\echo 'Before: workspace-wide expiration on every GET'
EXPLAIN (ANALYZE, BUFFERS)
UPDATE media_job SET state='failed',error='job deadline exceeded',updated_at=now()
WHERE workspace_id='00000000-0000-0000-0000-000000000001'
  AND state IN ('queued','running') AND expires_at<=now();

\echo 'After: exact-job expiration on GET'
EXPLAIN (ANALYZE, BUFFERS)
UPDATE media_job SET state='failed',error='job deadline exceeded',updated_at=now()
WHERE id=md5('job-100002')::uuid AND workspace_id='00000000-0000-0000-0000-000000000001'
  AND state IN ('queued','running') AND expires_at<=now();

\echo 'QueuedMediaJobs: routable caller and provider before LIMIT and SKIP LOCKED'
EXPLAIN (ANALYZE, BUFFERS)
SELECT j.* FROM media_job j
JOIN agent_runtime r ON r.id=md5('runtime-2')::uuid AND r.workspace_id=j.workspace_id
WHERE j.workspace_id='00000000-0000-0000-0000-000000000001'
  AND j.state='queued' AND j.expires_at>now()
  AND (r.owner_id=j.caller_id OR r.visibility='public' OR (r.visibility='private' AND j.caller_id=ANY(r.shared_with)))
  AND EXISTS (SELECT 1 FROM member m WHERE m.workspace_id=j.workspace_id AND m.user_id=j.caller_id)
  AND EXISTS (SELECT 1 FROM jsonb_to_recordset('[{"provider":"codex","capability":"image-generate"},{"provider":"codex","capability":"image-edit"}]'::jsonb)
              AS route(provider text,capability text)
              WHERE j.request->>'provider' IN ('auto',route.provider) AND j.request->>'capability'=route.capability)
ORDER BY j.created_at,j.id LIMIT 50 FOR UPDATE OF j SKIP LOCKED;

\echo 'AvailableMediaRuntimes: running partial index anti join'
EXPLAIN (ANALYZE, BUFFERS)
SELECT r.* FROM agent_runtime r
WHERE r.workspace_id='00000000-0000-0000-0000-000000000001' AND r.status='online' AND r.daemon_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM media_job j WHERE j.runtime_id=r.id AND j.state='running' AND j.expires_at>now())
ORDER BY r.id;

\echo 'SettleMediaRuntimeJobs: at most one running assignment'
EXPLAIN (ANALYZE, BUFFERS)
UPDATE media_job SET state=CASE WHEN attachment_id IS NOT NULL THEN 'completed' ELSE 'failed' END,
 error=CASE WHEN attachment_id IS NOT NULL THEN '' ELSE 'assignment lost' END,updated_at=now()
WHERE workspace_id='00000000-0000-0000-0000-000000000001'
  AND runtime_id=md5('runtime-1')::uuid AND state='running';
