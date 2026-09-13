-- name: LockConversationInstallation :one
SELECT * FROM channel_installation
WHERE id = $1 AND workspace_id = $2 AND channel_type = 'feishu'
FOR SHARE;

-- name: LockConversationInstallationForUpdate :one
-- Serialize consent edits and bounded discovery metadata updates with revoke
-- and reinstallation. Never replace credentials from a pre-lock snapshot.
SELECT * FROM channel_installation
WHERE id = $1 AND workspace_id = $2 AND channel_type = 'feishu'
FOR UPDATE;

-- name: SetLarkPrivateChatCandidates :exec
UPDATE channel_installation
SET config = jsonb_set(config, '{private_chat_candidates}', sqlc.arg('candidates')::jsonb)
WHERE id = $1 AND workspace_id = $2 AND channel_type = 'feishu';

-- name: SetConversationGrant :one
UPDATE channel_installation
SET config = jsonb_set(config, '{conversation}', sqlc.arg('grant')::jsonb), updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND channel_type = 'feishu'
RETURNING *;

-- name: SetLarkInstallationBotUnionID :one
-- Patch only this field: a background backfill must not restore a grant
-- revoked after it read the installation's old config.
UPDATE channel_installation
SET config = config || jsonb_build_object('bot_union_id', sqlc.narg('bot_union_id')::text), updated_at = now()
WHERE id = $1 AND channel_type = 'feishu'
RETURNING id;
