-- name: LabrastroLockAgentFolderWorkspace :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(workspace_id)::text, 9030));

-- name: LabrastroListAgentFolders :many
SELECT * FROM labrastro_agent_folder WHERE workspace_id=$1 ORDER BY name, id;

-- name: LabrastroGetAgentFolder :one
SELECT * FROM labrastro_agent_folder WHERE workspace_id=$1 AND id=$2;

-- name: LabrastroCreateAgentFolder :one
INSERT INTO labrastro_agent_folder (id, workspace_id, parent_id, name)
VALUES ($1,$2,$3,$4) RETURNING *;

-- name: LabrastroUpdateAgentFolder :one
UPDATE labrastro_agent_folder SET parent_id=$3, name=$4, updated_at=now()
WHERE workspace_id=$1 AND id=$2 RETURNING *;

-- name: LabrastroDeleteAgentFolder :exec
DELETE FROM labrastro_agent_folder WHERE workspace_id=$1 AND id=$2;

-- name: LabrastroPromoteAgentFolders :exec
UPDATE labrastro_agent_folder SET parent_id=sqlc.narg(destination), updated_at=now()
WHERE workspace_id=sqlc.arg(workspace_id) AND parent_id=sqlc.arg(folder_id);

-- name: LabrastroPromoteAgentPlacements :exec
WITH agents AS (
    UPDATE labrastro_agent_placement SET folder_id=sqlc.arg(destination)
    WHERE workspace_id=sqlc.arg(workspace_id) AND folder_id=sqlc.arg(folder_id)
)
UPDATE labrastro_agent_squad_placement p SET folder_id=sqlc.arg(destination)
WHERE p.workspace_id=sqlc.arg(workspace_id) AND p.folder_id=sqlc.arg(folder_id);

-- name: LabrastroRemoveFolderAgentPlacements :exec
WITH agents AS (
    DELETE FROM labrastro_agent_placement
    WHERE workspace_id=$1 AND folder_id=$2
)
DELETE FROM labrastro_agent_squad_placement p WHERE p.workspace_id=$1 AND p.folder_id=$2;

-- name: LabrastroListAgentPlacements :many
SELECT p.agent_id, p.folder_id FROM labrastro_agent_placement p
JOIN agent a ON a.id=p.agent_id AND a.workspace_id=p.workspace_id
JOIN labrastro_agent_folder f ON f.id=p.folder_id AND f.workspace_id=p.workspace_id
WHERE p.workspace_id=$1 ORDER BY p.agent_id;

-- name: LabrastroListAgentSquadFolders :many
SELECT s.id AS squad_id, s.name, s.avatar_url, s.leader_id, s.creator_id, f.id AS parent_id
FROM squad s
LEFT JOIN labrastro_agent_squad_placement p ON p.squad_id=s.id AND p.workspace_id=s.workspace_id
LEFT JOIN labrastro_agent_folder f ON f.id=p.folder_id AND f.workspace_id=s.workspace_id
WHERE s.workspace_id=$1 AND s.archived_at IS NULL ORDER BY s.name, s.id;

-- name: LabrastroPlaceAgent :exec
INSERT INTO labrastro_agent_placement (workspace_id,agent_id,folder_id) VALUES ($1,$2,$3)
ON CONFLICT (workspace_id,agent_id) DO UPDATE SET folder_id=EXCLUDED.folder_id;

-- name: LabrastroRemoveAgentPlacement :exec
DELETE FROM labrastro_agent_placement WHERE workspace_id=$1 AND agent_id=$2;

-- name: LabrastroPlaceAgentSquad :exec
INSERT INTO labrastro_agent_squad_placement (workspace_id,squad_id,folder_id) VALUES ($1,$2,$3)
ON CONFLICT (workspace_id,squad_id) DO UPDATE SET folder_id=EXCLUDED.folder_id;

-- name: LabrastroRemoveAgentSquadPlacement :exec
DELETE FROM labrastro_agent_squad_placement WHERE workspace_id=$1 AND squad_id=$2;

-- name: LabrastroLockFolderAgent :one
SELECT * FROM agent WHERE workspace_id=$1 AND id=$2 FOR SHARE;

-- name: LabrastroCleanAgentPlacements :exec
WITH agents AS (
    DELETE FROM labrastro_agent_placement p WHERE p.workspace_id=$1
    AND (NOT EXISTS (SELECT 1 FROM agent a WHERE a.id=p.agent_id AND a.workspace_id=p.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM labrastro_agent_folder f WHERE f.id=p.folder_id AND f.workspace_id=p.workspace_id))
)
DELETE FROM labrastro_agent_squad_placement p WHERE p.workspace_id=$1
AND (NOT EXISTS (SELECT 1 FROM squad s WHERE s.id=p.squad_id AND s.workspace_id=p.workspace_id AND s.archived_at IS NULL)
  OR NOT EXISTS (SELECT 1 FROM labrastro_agent_folder f WHERE f.id=p.folder_id AND f.workspace_id=p.workspace_id));

-- name: LabrastroDeleteWorkspaceAgentTree :exec
WITH agents AS (
    DELETE FROM labrastro_agent_placement WHERE workspace_id=$1
), squads AS (
    DELETE FROM labrastro_agent_squad_placement WHERE workspace_id=$1
)
DELETE FROM labrastro_agent_folder f WHERE f.workspace_id=$1;
