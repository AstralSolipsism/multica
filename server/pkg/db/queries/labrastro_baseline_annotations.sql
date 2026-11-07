-- name: LabrastroListAnnotationBatches :many
SELECT * FROM project_baseline_annotation_batch WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at, id;

-- name: LabrastroGetAnnotationBatch :one
SELECT * FROM project_baseline_annotation_batch WHERE workspace_id=$1 AND project_id=$2 AND id=$3;

-- name: LabrastroCreateAnnotationBatch :one
INSERT INTO project_baseline_annotation_batch (workspace_id,project_id,chapter,carrier_kind,issue_id,agent_id,created_by_type,created_by_id)
VALUES ($1,$2,$3,$4,$5,$6,'member',$7) RETURNING *;

-- name: LabrastroSetAnnotationCarrier :one
UPDATE project_baseline_annotation_batch SET issue_id=$4 WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING *;

-- name: LabrastroCloseAnnotationBatch :one
UPDATE project_baseline_annotation_batch SET closed_at=now(),close_reason=$4,closed_by_type=$5,closed_by_id=$6,closed_revision_id=$7
WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND closed_at IS NULL RETURNING *;

-- name: LabrastroGetBaselineReviewByKey :one
SELECT * FROM project_baseline_review WHERE workspace_id=$1 AND project_id=$2 AND client_key=$3;

-- name: LabrastroListBaselineReviews :many
SELECT * FROM project_baseline_review WHERE workspace_id=$1 AND project_id=$2 AND batch_id=$3 ORDER BY created_at,id;

-- name: LabrastroCreateBaselineReview :one
INSERT INTO project_baseline_review (workspace_id,project_id,batch_id,client_key,reviewed_revision_id,summary,created_by_type,created_by_id)
VALUES ($1,$2,$3,$4,$5,$6,'member',$7) RETURNING *;

-- name: LabrastroSetBaselineReviewComment :one
UPDATE project_baseline_review SET wake_comment_id=$4 WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING *;

-- name: LabrastroListBaselineAnnotations :many
SELECT * FROM project_baseline_annotation WHERE workspace_id=$1 AND project_id=$2 AND batch_id=$3 ORDER BY ordinal;

-- name: LabrastroGetBaselineAnnotation :one
SELECT * FROM project_baseline_annotation WHERE workspace_id=$1 AND project_id=$2 AND id=$3;

-- name: LabrastroCreateBaselineAnnotation :one
INSERT INTO project_baseline_annotation (workspace_id,project_id,batch_id,review_id,ordinal,parent_annotation_id,
anchor_kind,target_revision_id,target_revision_number,section_anchor,section_title,line_start,line_end,quote,prefix,suffix,start,note,created_by_type,created_by_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'member',$19) RETURNING *;

-- name: LabrastroRespondBaselineAnnotation :exec
UPDATE project_baseline_annotation SET response=$4,responded_at=now(),responded_by_task_id=$5
WHERE workspace_id=$1 AND project_id=$2 AND id=$3;

-- name: LabrastroResolveBaselineAnnotation :exec
UPDATE project_baseline_annotation SET resolved_at=CASE WHEN sqlc.arg(resolved)::boolean THEN now() ELSE NULL END,
resolved_by_type=CASE WHEN sqlc.arg(resolved)::boolean THEN 'member' ELSE NULL END,
resolved_by_id=CASE WHEN sqlc.arg(resolved)::boolean THEN sqlc.arg(actor_id)::uuid ELSE NULL END
WHERE workspace_id=$1 AND project_id=$2 AND id=$3;

-- name: LabrastroCloseRelatedAnnotationBatches :many
UPDATE project_baseline_annotation_batch b SET closed_at=now(),close_reason=sqlc.arg(reason),closed_by_type='member',
closed_by_id=sqlc.arg(actor_id),closed_revision_id=sqlc.arg(revision_id)
WHERE b.workspace_id=sqlc.arg(workspace_id) AND b.project_id=sqlc.arg(project_id) AND b.chapter=sqlc.arg(chapter)
AND b.closed_at IS NULL AND (b.issue_id=sqlc.narg(source_issue_id)::uuid OR EXISTS (
SELECT 1 FROM project_baseline_review r WHERE r.workspace_id=b.workspace_id AND r.project_id=b.project_id AND r.batch_id=b.id AND r.reviewed_revision_id=sqlc.arg(revision_id)))
RETURNING b.*;
