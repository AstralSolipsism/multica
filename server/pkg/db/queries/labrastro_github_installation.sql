-- Fork additions for reusable GitHub App installations (OL-928).
-- Kept out of upstream's github.sql so upstream syncs don't conflict.

-- name: ListManagedGitHubInstallationIDsByUser :many
-- Installation IDs bound to any workspace where the user is owner/admin.
-- This is the reuse allowlist: a caller may re-bind an installation to a new
-- workspace only if they already manage it somewhere (review option A).
SELECT gi.installation_id
FROM github_installation gi
JOIN member m ON m.workspace_id = gi.workspace_id
WHERE m.user_id = $1 AND m.role IN ('owner', 'admin');
