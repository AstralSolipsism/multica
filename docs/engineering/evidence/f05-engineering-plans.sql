-- F05 (OL-1276) synthetic engineering dataset and EXPLAIN probes.
-- Disposable database only: psql -f this-file. Seeds one 24-chapter project (40 revisions x ~60KB each),
-- 600 noise projects across two workspaces and 42,000 issues, then prints plans for every F05 read path.

\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE ids AS SELECT gen_random_uuid() AS ws, gen_random_uuid() AS other_ws, gen_random_uuid() AS project, gen_random_uuid() AS actor;
-- target project: 4 global + 20 module chapters, 40 revisions each, ~60KB content.
INSERT INTO project_engineering (workspace_id, project_id, enabled, current_stage, updated_by_type, updated_by_id, stages)
SELECT ws, project, true, 2, 'member', actor, '[{"stage":1,"title":"A","goal":""},{"stage":2,"title":"B","goal":""}]' FROM ids;
CREATE TEMP TABLE chapters AS
SELECT c AS chapter, n AS position FROM unnest(ARRAY['overview','domain_rules','architecture','exclusions_and_risks']) WITH ORDINALITY AS t(c, n)
UNION ALL SELECT 'module:m' || g, 100 + g FROM generate_series(1, 20) g;
CREATE TEMP TABLE body AS
SELECT string_agg(format(E'## Section %s\n\n%s\n\n### Detail %s\n\nWhy: %s\n', g, repeat(md5(g::text || random()::text) || ' ', 12), g, md5(random()::text)), E'\n') AS content
FROM generate_series(1, 120) g;
INSERT INTO project_baseline_revision (workspace_id, project_id, chapter, revision_number, status, content_markdown, change_summary, anchors_diff, created_by_type, created_by_id)
SELECT i.ws, i.project, c.chapter, r,
  CASE WHEN r = 40 THEN 'candidate' WHEN r = 39 THEN 'adopted' ELSE 'superseded' END,
  left(b.content || md5(r::text || c.chapter), 61000), 'summary ' || r,
  jsonb_build_object('chapter', c.chapter, 'base_revision_number', r - 1, 'added', '[]'::jsonb,
    'modified', jsonb_build_array(jsonb_build_object('anchor','Section 1','title','Section 1','before', repeat('x', 2000),'after', repeat('y', 2000))),
    'removed', '[]'::jsonb, 'unchanged_count', 200, 'warnings', '[]'::jsonb),
  'agent', i.actor
FROM ids i, chapters c, body b, generate_series(1, 40) r;
INSERT INTO project_baseline_doc (workspace_id, project_id, chapter, adopted_revision_id, candidate_revision_id, title, position)
SELECT i.ws, i.project, c.chapter,
  (SELECT id FROM project_baseline_revision r WHERE r.workspace_id = i.ws AND r.project_id = i.project AND r.chapter = c.chapter AND r.status = 'adopted'),
  (SELECT id FROM project_baseline_revision r WHERE r.workspace_id = i.ws AND r.project_id = i.project AND r.chapter = c.chapter AND r.status = 'candidate'),
  CASE WHEN c.chapter LIKE 'module:%' THEN 'Module ' || c.position ELSE '' END, c.position
FROM ids i, chapters c;
-- noise: 300 other projects in the same workspace and 300 in another workspace, 4 chapters x 10 revisions x ~8KB.
CREATE TEMP TABLE noise AS SELECT CASE WHEN g <= 300 THEN i.ws ELSE i.other_ws END AS ws, gen_random_uuid() AS project FROM ids i, generate_series(1, 600) g;
INSERT INTO project_baseline_revision (workspace_id, project_id, chapter, revision_number, status, content_markdown, change_summary, anchors_diff, created_by_type, created_by_id)
SELECT n.ws, n.project, c, r, CASE WHEN r = 10 THEN 'adopted' ELSE 'superseded' END, left(b.content, 8000), 's', '{}'::jsonb, 'member', (SELECT actor FROM ids)
FROM noise n, unnest(ARRAY['overview','domain_rules','architecture','exclusions_and_risks']) c, body b, generate_series(1, 10) r;
INSERT INTO project_baseline_doc (workspace_id, project_id, chapter) SELECT n.ws, n.project, c FROM noise n, unnest(ARRAY['overview','domain_rules','architecture','exclusions_and_risks']) c;
INSERT INTO project_engineering (workspace_id, project_id, enabled, updated_by_type, updated_by_id) SELECT ws, project, true, 'member', (SELECT actor FROM ids) FROM noise;
INSERT INTO workspace (id, name, slug, issue_prefix) SELECT ws, 'F05 bench', 'f05-bench-' || left(ws::text, 8), 'F' FROM ids;
INSERT INTO workspace (id, name, slug, issue_prefix) SELECT other_ws, 'F05 other', 'f05-other-' || left(other_ws::text, 8), 'O' FROM ids;
INSERT INTO project (id, workspace_id, title) SELECT project, ws, 'Target' FROM ids;
INSERT INTO project (id, workspace_id, title) SELECT project, ws, 'Noise' FROM noise;
-- issues: 2,000 in the target project, 20,000 elsewhere in the workspace, 20,000 in another workspace.
INSERT INTO issue (workspace_id, project_id, title, status, creator_type, creator_id, number, created_at)
SELECT CASE WHEN g <= 22000 THEN i.ws ELSE i.other_ws END,
  CASE WHEN g <= 2000 THEN i.project ELSE (SELECT project FROM noise OFFSET (g % 300) LIMIT 1) END,
  'Issue ' || g, (ARRAY['backlog','todo','in_progress','in_review','done','done','done','cancelled'])[1 + g % 8], 'member', i.actor, g,
  now() - (g || ' minutes')::interval
FROM ids i, generate_series(1, 42000) g;
CREATE TABLE f05_ids AS SELECT * FROM ids;
COMMIT;
ANALYZE project_engineering; ANALYZE project_baseline_doc; ANALYZE project_baseline_revision; ANALYZE issue;
SELECT count(*) AS revisions, pg_size_pretty(pg_total_relation_size('project_baseline_revision')) AS size FROM project_baseline_revision;

SELECT ws AS ws, project AS project FROM f05_ids \gset
\echo == GetEngineering
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT * FROM project_engineering WHERE workspace_id = :'ws' AND project_id = :'project';
\echo == ListBaselineDocs
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT * FROM project_baseline_doc WHERE workspace_id = :'ws' AND project_id = :'project' ORDER BY chapter;
SELECT adopted_revision_id AS rid FROM project_baseline_doc WHERE workspace_id = :'ws' AND project_id = :'project' AND chapter = 'architecture' \gset
\echo == GetBaselineRevision (one of 2N lookups)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT * FROM project_baseline_revision WHERE workspace_id = :'ws' AND project_id = :'project' AND id = :'rid';
\echo == LabrastroListBaselineRevisionsByID (one query for every adopted + candidate pointer)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT r.* FROM project_baseline_revision r
WHERE r.workspace_id = :'ws' AND r.project_id = :'project'
  AND r.id = ANY(ARRAY(SELECT unnest(ARRAY[d.adopted_revision_id, d.candidate_revision_id]) FROM project_baseline_doc d WHERE d.workspace_id = :'ws' AND d.project_id = :'project'));
\echo == ListBaselineRevisions limit 51
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT * FROM project_baseline_revision WHERE workspace_id = :'ws' AND project_id = :'project' AND chapter = 'architecture' AND (NULL::int IS NULL OR revision_number < NULL::int) ORDER BY revision_number DESC LIMIT 51;
\echo == ListBaselineRevisions before=20
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT * FROM project_baseline_revision WHERE workspace_id = :'ws' AND project_id = :'project' AND chapter = 'architecture' AND (20::int IS NULL OR revision_number < 20::int) ORDER BY revision_number DESC LIMIT 51;
\echo == CreateBaselineRevision MAX subquery
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT COALESCE(MAX(r.revision_number),0)::int + 1 FROM project_baseline_revision r WHERE r.workspace_id = :'ws' AND r.project_id = :'project' AND r.chapter = 'architecture';
\echo == GetBaselineRevisionNumber
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT * FROM project_baseline_revision WHERE workspace_id = :'ws' AND project_id = :'project' AND chapter = 'architecture' AND revision_number = 12;
\echo == BaselineOpenIssues
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY ON) SELECT i.id, i.title, i.status, i.number, i.assignee_type, i.assignee_id FROM issue i WHERE i.workspace_id = :'ws' AND i.project_id = :'project' AND i.status = ANY(ARRAY['backlog','todo','in_progress','in_review']) ORDER BY i.created_at, i.id LIMIT 201;
\echo == Payload: adopted + candidate content bytes for GET /engineering
SELECT count(*) AS revisions, pg_size_pretty(sum(octet_length(r.content_markdown) + octet_length(r.anchors_diff::text))) AS raw_bytes
FROM project_baseline_doc d JOIN project_baseline_revision r ON r.id IN (d.adopted_revision_id, d.candidate_revision_id)
WHERE d.workspace_id = :'ws' AND d.project_id = :'project';
