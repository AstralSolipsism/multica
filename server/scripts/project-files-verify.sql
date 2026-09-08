-- Read-only post-migration and post-test verification. Object availability must
-- additionally be checked through the authenticated content endpoints.
BEGIN READ ONLY;
DO $$
DECLARE broken text;
BEGIN
    SELECT string_agg(expected.name, ', ') INTO broken
    FROM (VALUES
      ('idx_project_file_id'), ('idx_project_file_path'),
      ('idx_project_file_version_id'), ('idx_project_file_version_revision'),
      ('idx_project_file_operation_id'), ('idx_project_file_operation_scope'),
      ('idx_project_file_candidate_id'), ('idx_project_file_candidate_list'),
      ('idx_project_file_upload_id'), ('idx_project_file_upload_operation')
    ) AS expected(name)
    LEFT JOIN pg_class c ON c.oid = to_regclass(expected.name)
    LEFT JOIN pg_index i ON i.indexrelid = c.oid
    WHERE i.indexrelid IS NULL OR NOT i.indisvalid OR NOT i.indisready;
    IF broken IS NOT NULL THEN RAISE EXCEPTION 'Missing or invalid project file indexes: %', broken; END IF;

    IF EXISTS (
      SELECT 1 FROM project_file f LEFT JOIN project_file_version v
        ON v.id = f.current_version_id AND v.file_id = f.id
        AND v.workspace_id = f.workspace_id AND v.project_id = f.project_id
        AND v.revision = f.revision
      WHERE v.id IS NULL OR f.revision < 1
    ) THEN RAISE EXCEPTION 'Invalid current file pointer'; END IF;

    IF EXISTS (
      SELECT 1 FROM project_file_candidate c LEFT JOIN project_file_version v
        ON v.id = c.version_id AND v.file_id = c.file_id
        AND v.workspace_id = c.workspace_id AND v.project_id = c.project_id
      WHERE v.id IS NULL OR v.revision IS NOT NULL
    ) THEN RAISE EXCEPTION 'Invalid candidate version'; END IF;

    IF EXISTS (
      SELECT 1 FROM project_file_version v LEFT JOIN project_file_operation o
        ON o.id = v.operation_id AND o.workspace_id = v.workspace_id AND o.project_id = v.project_id
      WHERE o.id IS NULL OR o.result IS NULL
    ) THEN RAISE EXCEPTION 'Version without completed operation'; END IF;

    IF EXISTS (
      SELECT 1 FROM project_file_upload u WHERE u.state = 'referenced'
      AND NOT EXISTS (SELECT 1 FROM project_file_version v WHERE v.object_key = u.object_key
        AND v.workspace_id = u.workspace_id AND v.project_id = u.project_id)
    ) THEN RAISE EXCEPTION 'Referenced upload without a version'; END IF;

    IF EXISTS (
      SELECT 1 FROM project_file_operation WHERE result IS NOT NULL AND (
        COALESCE(result->>'status', '') NOT IN ('SAVED', 'CONFLICT')
        OR result->>'operation_id' IS DISTINCT FROM operation_key
        OR (result->>'status' = 'SAVED' AND result ? 'candidate_id')
        OR (result->>'status' = 'CONFLICT' AND NOT result ? 'candidate_id')
      )
    ) THEN RAISE EXCEPTION 'Invalid replay result'; END IF;
END $$;
SELECT 'project file metadata invariants OK' AS verification;
SELECT state, count(*) AS upload_attempts FROM project_file_upload GROUP BY state ORDER BY state;
COMMIT;
