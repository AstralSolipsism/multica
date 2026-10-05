-- name: LabrastroLockSkillWorkspace :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(workspace_id)::text, 9001));

-- name: LabrastroLockSkillWorkspaceLifetime :one
SELECT id FROM workspace WHERE id=$1 FOR KEY SHARE;

-- name: LabrastroLockSkillMember :one
SELECT * FROM member WHERE workspace_id = $1 AND user_id = $2 FOR SHARE;

-- name: LabrastroLockSkill :one
SELECT * FROM skill WHERE workspace_id = $1 AND id = $2 FOR UPDATE;

-- name: LabrastroListSkillStates :many
SELECT s.id,s.workspace_id,s.name,s.description,s.config,s.created_by,s.updated_at,
encode(sha256(convert_to(s.content,'UTF8')),'hex') AS content_hash,
COALESCE((SELECT jsonb_agg(jsonb_build_array(f.path,encode(sha256(convert_to(f.content,'UTF8')),'hex')) ORDER BY f.path)
FROM skill_file f WHERE f.skill_id=s.id),'[]'::jsonb)::jsonb AS file_hashes
FROM skill s WHERE s.workspace_id=$1 ORDER BY s.id;

-- name: LabrastroGetSkillState :one
SELECT s.id,s.workspace_id,s.name,s.description,s.config,s.created_by,s.updated_at,
encode(sha256(convert_to(s.content,'UTF8')),'hex') AS content_hash,
COALESCE((SELECT jsonb_agg(jsonb_build_array(f.path,encode(sha256(convert_to(f.content,'UTF8')),'hex')) ORDER BY f.path)
FROM skill_file f WHERE f.skill_id=s.id),'[]'::jsonb)::jsonb AS file_hashes
FROM skill s WHERE s.workspace_id=$1 AND s.id=$2;

-- name: LabrastroGetSkillPlacement :one
SELECT * FROM labrastro_skill_placement WHERE workspace_id=$1 AND skill_id=$2;

-- name: LabrastroListSkillFolders :many
SELECT * FROM labrastro_skill_folder WHERE workspace_id = $1 ORDER BY name, id;

-- name: LabrastroGetSkillFolder :one
SELECT * FROM labrastro_skill_folder WHERE workspace_id = $1 AND id = $2;

-- name: LabrastroCreateSkillFolder :one
INSERT INTO labrastro_skill_folder (id,workspace_id,parent_id,name,package_id,package_path)
VALUES ($1,$2,$3,$4,$5,$6) RETURNING *;

-- name: LabrastroUpdateSkillFolder :one
UPDATE labrastro_skill_folder SET parent_id=$3,name=$4,updated_at=now()
WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: LabrastroDeleteSkillFolder :exec
DELETE FROM labrastro_skill_folder WHERE workspace_id=$1 AND id=$2;

-- name: LabrastroPromoteSkillFolders :exec
UPDATE labrastro_skill_folder SET parent_id=$3,updated_at=now()
WHERE workspace_id=$1 AND parent_id=$2;

-- name: LabrastroPromoteSkillPlacements :exec
UPDATE labrastro_skill_placement SET folder_id=$3 WHERE workspace_id=$1 AND folder_id=$2;

-- name: LabrastroListSkillPackages :many
SELECT * FROM labrastro_skill_package WHERE workspace_id=$1 ORDER BY owner_repo,subdirectory;

-- name: LabrastroGetSkillPackage :one
SELECT * FROM labrastro_skill_package WHERE workspace_id=$1 AND id=$2;

-- name: LabrastroCreateSkillPackage :one
INSERT INTO labrastro_skill_package (id,workspace_id,owner_repo,subdirectory,source_url,source_ref,root_folder_id,created_by,candidates)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *;

-- name: LabrastroApplySkillPackage :one
UPDATE labrastro_skill_package SET source_url=$3,source_ref=$4,candidates=$5,revision=revision+1,updated_at=now()
WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: LabrastroDeleteSkillPackage :exec
DELETE FROM labrastro_skill_package WHERE workspace_id=$1 AND id=$2;

-- name: LabrastroListSkillPlacements :many
SELECT p.* FROM labrastro_skill_placement p JOIN skill s ON s.id=p.skill_id AND s.workspace_id=p.workspace_id
JOIN labrastro_skill_folder f ON f.id=p.folder_id AND f.workspace_id=p.workspace_id
WHERE p.workspace_id=$1 ORDER BY p.skill_id;

-- name: LabrastroPlaceSkill :exec
INSERT INTO labrastro_skill_placement (workspace_id,skill_id,folder_id,package_id,source_path)
VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (workspace_id,skill_id) DO UPDATE SET folder_id=EXCLUDED.folder_id,package_id=EXCLUDED.package_id,source_path=EXCLUDED.source_path;

-- name: LabrastroRemoveSkillPlacement :exec
DELETE FROM labrastro_skill_placement WHERE workspace_id=$1 AND skill_id=$2;

-- name: LabrastroCleanSkillPlacements :exec
DELETE FROM labrastro_skill_placement p WHERE p.workspace_id=$1
AND NOT EXISTS (SELECT 1 FROM skill s WHERE s.id=p.skill_id AND s.workspace_id=p.workspace_id);

-- name: LabrastroDissolveSkillFolders :exec
UPDATE labrastro_skill_folder SET package_id=NULL,package_path=NULL,updated_at=now() WHERE workspace_id=$1 AND package_id=$2;

-- name: LabrastroDissolveSkillPlacements :exec
UPDATE labrastro_skill_placement SET package_id=NULL,source_path=NULL WHERE workspace_id=$1 AND package_id=$2;

-- name: LabrastroDetachSkill :exec
UPDATE labrastro_skill_placement SET package_id=NULL,source_path=NULL WHERE workspace_id=$1 AND skill_id=$2;

-- name: LabrastroDeletePackageFolders :exec
DELETE FROM labrastro_skill_folder WHERE workspace_id=$1 AND package_id=$2;

-- name: LabrastroDeleteWorkspaceSkillTree :exec
WITH placements AS (
    DELETE FROM labrastro_skill_placement p WHERE p.workspace_id=$1
), folders AS (
    DELETE FROM labrastro_skill_folder f WHERE f.workspace_id=$1
)
DELETE FROM labrastro_skill_package p WHERE p.workspace_id=$1;

-- name: LabrastroPruneSkillPackageFolders :exec
WITH RECURSIVE occupied AS (
    SELECT f.id,f.parent_id FROM labrastro_skill_folder f
    WHERE f.workspace_id=sqlc.arg(workspace_id) AND EXISTS (
        SELECT 1 FROM labrastro_skill_placement p
        WHERE p.workspace_id=f.workspace_id AND p.folder_id=f.id
    )
    UNION
    SELECT f.id,f.parent_id FROM labrastro_skill_folder f
    JOIN occupied o ON o.parent_id=f.id
    WHERE f.workspace_id=sqlc.arg(workspace_id)
)
DELETE FROM labrastro_skill_folder f
WHERE f.workspace_id=sqlc.arg(workspace_id) AND f.package_id=sqlc.arg(package_id)
AND (NOT sqlc.arg(keep_root)::boolean OR f.package_path <> '')
AND NOT EXISTS (SELECT 1 FROM occupied o WHERE o.id=f.id);

-- name: LabrastroDeletePackagePlacements :exec
DELETE FROM labrastro_skill_placement WHERE workspace_id=$1 AND package_id=$2;

-- name: LabrastroDeleteSkillBindings :exec
DELETE FROM agent_skill WHERE skill_id IN (SELECT id FROM skill WHERE workspace_id=$1 AND id=$2);

-- name: LabrastroSkillBindingImpact :many
SELECT a.id,a.name,s.id AS skill_id,s.name AS skill_name FROM agent_skill b
JOIN agent a ON a.id=b.agent_id JOIN skill s ON s.id=b.skill_id AND s.workspace_id=a.workspace_id
WHERE s.workspace_id=$1 AND s.id=ANY(sqlc.arg(skill_ids)::uuid[]) ORDER BY a.id,s.id;
