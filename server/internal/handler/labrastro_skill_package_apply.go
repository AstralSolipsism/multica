package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type labrastroTargetIndex struct {
	states map[pgtype.UUID]db.LabrastroListSkillStatesRow
	places map[pgtype.UUID]db.LabrastroSkillPlacement
}

func labrastroIndexTargets(s labrastroPackageSnapshot) labrastroTargetIndex {
	index := labrastroTargetIndex{map[pgtype.UUID]db.LabrastroListSkillStatesRow{}, map[pgtype.UUID]db.LabrastroSkillPlacement{}}
	for _, st := range s.States {
		index.states[st.ID] = st
	}
	for _, p := range s.Places {
		index.places[p.SkillID] = p
	}
	return index
}

type labrastroItemError struct {
	code, reason string
	retryable    bool
}

func (e *labrastroItemError) Error() string { return e.reason }
func labrastroItemFailure(code, reason string, retryable bool) error {
	return &labrastroItemError{code, reason, retryable}
}

func labrastroFailedItem(ctx context.Context, result LabrastroPackageItemResult, err error) LabrastroPackageItemResult {
	var item *labrastroItemError
	if !errors.As(err, &item) {
		item = &labrastroItemError{"item_failed", err.Error(), true}
	}
	// The deadline can expire inside a query or commit. Preserve earlier
	// successful items and classify every remaining item as retryable.
	if ctx.Err() != nil {
		result.Status = "failed"
		item = &labrastroItemError{"source_timeout", ctx.Err().Error(), true}
	}
	result.Code, result.Reason, result.Retryable = item.code, item.reason, item.retryable
	return result
}

func labrastroCandidateTerminal(c LabrastroSkillCandidate, decision labrastroCandidateDecision) (string, error) {
	switch decision.action {
	case labrastroSkip:
		return "skipped", labrastroItemFailure(c.Conflict, labrastroCandidateConflictReason(c.Conflict), false)
	case labrastroReject:
		code := c.Conflict
		if code == "" {
			code = "candidate_failed"
		}
		return "failed", labrastroItemFailure(code, labrastroCandidateConflictReason(c.Conflict), false)
	case labrastroFailed:
		if len(c.Diagnostics) > 0 {
			d := c.Diagnostics[0]
			return "failed", labrastroItemFailure(d.Code, d.Message, d.Retryable)
		}
		return "failed", labrastroItemFailure("candidate_failed", "candidate could not be fetched; preview again", true)
	default:
		return "", nil
	}
}

func labrastroCandidateConflictReason(conflict string) string {
	switch conflict {
	case "already_packaged", "ambiguous_source":
		return "detach from the other package or resolve the ambiguous source first"
	case "forbidden":
		return "permission required to adopt or update this skill"
	case "name_conflict":
		return "existing skill left unchanged"
	default:
		return "unsupported candidate state; preview again"
	}
}

func labrastroRevalidateBundle(ctx context.Context, src *labrastroSkillSource, c LabrastroSkillCandidate) (*importedSkill, error) {
	bundle, err := src.bundle(ctx, c.Path)
	if err != nil {
		var detail *labrastroImportError
		if errors.As(err, &detail) {
			return nil, err
		}
		return nil, labrastroItemFailure("source_unavailable", err.Error(), !isCapError(err))
	}
	if labrastroBundleDigest(bundle) != c.Digest {
		return nil, labrastroItemFailure("source_changed", "candidate changed since preview", true)
	}
	return bundle, nil
}

func labrastroRevalidatePackage(ctx context.Context, q *db.Queries, a labrastroSkillActor, member db.Member, expected db.LabrastroSkillPackage) error {
	current, err := q.LabrastroGetSkillPackage(ctx, db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: expected.ID})
	if err != nil {
		return labrastroItemFailure("preview_stale", "package was removed", true)
	}
	if current.Revision != expected.Revision || current.SourceUrl != expected.SourceUrl || current.SourceRef != expected.SourceRef {
		return labrastroItemFailure("preview_stale", "package source changed during apply", true)
	}
	if err := labrastroRequirePackageOwner(current, a, member); err != nil {
		return labrastroItemFailure("forbidden", err.Error(), false)
	}
	return nil
}

func labrastroAllowCandidateTarget(permission labrastroCandidatePermission, a labrastroSkillActor, member db.Member, target db.Skill) bool {
	switch permission {
	case labrastroCreatorPermission:
		return canOverwriteSkillByLocalImport(uuidToString(a.user), target)
	case labrastroManagePermission:
		return labrastroCanManage(target.CreatedBy, a, member)
	default:
		return false
	}
}

func labrastroLoadCandidateTarget(ctx context.Context, q *db.Queries, a labrastroSkillActor, member db.Member, p db.LabrastroSkillPackage, index labrastroTargetIndex, c LabrastroSkillCandidate, decision labrastroCandidateDecision) (db.Skill, error) {
	var target db.Skill
	if !decision.writesTarget() {
		return target, nil
	}
	if c.SkillID == "" {
		return target, labrastroItemFailure("preview_stale", "candidate has no target", true)
	}
	target, err := q.LabrastroLockSkill(ctx, db.LabrastroLockSkillParams{WorkspaceID: a.ws, ID: parseUUID(c.SkillID)})
	if err != nil {
		return target, labrastroItemFailure("preview_stale", "target disappeared", true)
	}
	original, found := index.states[target.ID]
	state, err := q.LabrastroGetSkillState(ctx, db.LabrastroGetSkillStateParams{WorkspaceID: a.ws, ID: target.ID})
	if err != nil {
		return target, labrastroItemFailure("operation_failed", "could not recheck target", true)
	}
	if !found || labrastroJSONHash(state) != labrastroJSONHash(original) {
		return target, labrastroItemFailure("preview_stale", "target changed since preview", true)
	}
	place, err := q.LabrastroGetSkillPlacement(ctx, db.LabrastroGetSkillPlacementParams{WorkspaceID: a.ws, SkillID: target.ID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return target, labrastroItemFailure("operation_failed", "could not recheck placement", true)
	}
	if place.PackageID.Valid && (decision.action == labrastroOverwrite || place.PackageID != p.ID || place.SourcePath.String != c.Path) {
		return target, labrastroItemFailure("already_packaged", "target belongs to another package or path", false)
	}
	if place != index.places[target.ID] {
		return target, labrastroItemFailure("preview_stale", "target placement changed since preview", true)
	}
	if !labrastroAllowCandidateTarget(decision.permission, a, member, target) {
		reason := "only the skill creator or workspace admin can adopt/update"
		if decision.permission == labrastroCreatorPermission {
			reason = "only the skill creator can overwrite a different source"
		}
		return target, labrastroItemFailure("forbidden", reason, false)
	}
	return target, nil
}

func labrastroCandidateWriteName(ctx context.Context, q *db.Queries, a labrastroSkillActor, src *labrastroSkillSource, bundle *importedSkill, target db.Skill, c LabrastroSkillCandidate, decision labrastroCandidateDecision, strategy string) (string, error) {
	name := sanitizeNullBytes(bundle.name)
	if decision.action == labrastroUpdate || decision.action == labrastroAdopt {
		// Compare with the last persisted frontmatter, not package summaries
		// that may already have advanced for failed or deselected candidates.
		previous, _ := src.metadata(target.Content, c.Path)
		if sanitizeNullBytes(previous) == name {
			name = target.Name
		}
	}
	if !decision.writesTarget() && strategy == "rename" {
		return labrastroAvailableCandidateName(ctx, q, a.ws, name)
	}
	return name, nil
}

func labrastroAvailableCandidateName(ctx context.Context, q *db.Queries, ws pgtype.UUID, base string) (string, error) {
	// Check the base under the workspace lock too: another candidate from
	// this same preview may have created it since candidate resolution.
	name := base
	for attempt := 0; attempt <= maxImportRenameAttempts; attempt++ {
		_, err := q.GetSkillByWorkspaceAndName(ctx, db.GetSkillByWorkspaceAndNameParams{WorkspaceID: ws, Name: name})
		if errors.Is(err, pgx.ErrNoRows) {
			return name, nil
		}
		if err != nil {
			return "", labrastroItemFailure("operation_failed", "could not choose a new name", true)
		}
		name = fmt.Sprintf("%s-%d", base, attempt+2)
	}
	return "", labrastroItemFailure("name_conflict", "no available name within the rename limit", false)
}

func labrastroWriteCandidate(ctx context.Context, q *db.Queries, a labrastroSkillActor, member db.Member, p db.LabrastroSkillPackage, raw []LabrastroSkillCandidate, c LabrastroSkillCandidate, decision labrastroCandidateDecision, target db.Skill, bundle *importedSkill, name string) (SkillWithFilesResponse, error) {
	var written SkillWithFilesResponse
	folder, err := labrastroPackageFolder(ctx, q, a.ws, p, c.Path, raw)
	if err != nil {
		return written, labrastroItemFailure("folder_conflict", "could not place candidate in the managed tree", false)
	}
	if decision.writesTarget() {
		allow := func(_ string, s db.Skill) bool {
			return labrastroAllowCandidateTarget(decision.permission, a, member, s)
		}
		written, err = overwriteSkillWithFilesInTx(ctx, q, skillOverwriteInput{WorkspaceID: a.ws, TargetSkillID: target.ID, UserID: uuidToString(a.user), NewName: name, AllowOverwrite: allow, Description: bundle.description, Content: bundle.content, Config: mergeSkillConfigOrigin(target.Config, bundle.origin), Files: importedSkillFileRequests(bundle)})
	} else {
		written, err = createSkillWithFilesInTx(ctx, q, skillCreateInput{WorkspaceID: a.ws, CreatorID: a.user, Name: name, Description: bundle.description, Content: bundle.content, Config: map[string]any{"origin": bundle.origin}, Files: importedSkillFileRequests(bundle)})
	}
	if err != nil {
		if isUniqueViolation(err) || errors.Is(err, errSkillOverwriteNameConflict) {
			return written, labrastroItemFailure("name_conflict", "another skill has the imported name", false)
		}
		return written, labrastroItemFailure("item_failed", "skill contents and placement rolled back", true)
	}
	if err = q.LabrastroPlaceSkill(ctx, db.LabrastroPlaceSkillParams{WorkspaceID: a.ws, SkillID: parseUUID(written.ID), FolderID: folder, PackageID: p.ID, SourcePath: pgtype.Text{String: c.Path, Valid: true}}); err == nil {
		err = q.LabrastroPruneSkillPackageFolders(ctx, db.LabrastroPruneSkillPackageFoldersParams{WorkspaceID: a.ws, PackageID: p.ID, KeepRoot: true})
	}
	if err != nil {
		return written, labrastroItemFailure("placement_conflict", "skill contents and placement rolled back", true)
	}
	return written, nil
}

func (h *Handler) labrastroApplyCandidate(ctx context.Context, r *http.Request, a labrastroSkillActor, p db.LabrastroSkillPackage, src *labrastroSkillSource, index labrastroTargetIndex, raw []LabrastroSkillCandidate, c LabrastroSkillCandidate, req labrastroPackageRequest) LabrastroPackageItemResult {
	result := LabrastroPackageItemResult{Path: c.Path, Status: "failed", SkillID: c.SkillID, Diagnostics: c.Diagnostics}
	fail := func(err error) LabrastroPackageItemResult { return labrastroFailedItem(ctx, result, err) }
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	decision := labrastroDecideCandidate(c, req)
	if status, err := labrastroCandidateTerminal(c, decision); err != nil {
		result.Status = status
		return fail(err)
	}
	bundle, err := labrastroRevalidateBundle(ctx, src, c)
	if err != nil {
		var detail *labrastroImportError
		if errors.As(err, &detail) {
			result.Diagnostics = append(result.Diagnostics, detail.Diagnostic)
			err = labrastroItemFailure(detail.Diagnostic.Code, err.Error(), detail.Diagnostic.Retryable)
		}
		return fail(err)
	}
	tx, q, member, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		return fail(labrastroItemFailure("permission_changed", "could not enter workspace transaction", true))
	}
	defer tx.Rollback(ctx)
	if err = labrastroRevalidatePackage(ctx, q, a, member, p); err != nil {
		return fail(err)
	}
	target, err := labrastroLoadCandidateTarget(ctx, q, a, member, p, index, c, decision)
	if err != nil {
		return fail(err)
	}
	name, err := labrastroCandidateWriteName(ctx, q, a, src, bundle, target, c, decision, req.OnConflict)
	if err != nil {
		return fail(err)
	}
	written, err := labrastroWriteCandidate(ctx, q, a, member, p, raw, c, decision, target, bundle, name)
	if err != nil {
		return fail(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return fail(labrastroItemFailure("item_failed", "skill transaction did not commit; preview again", true))
	}
	result.SkillID, result.Status = written.ID, "created"
	event := protocol.EventSkillCreated
	if decision.writesTarget() {
		result.Status, event = "updated", protocol.EventSkillUpdated
		if decision.action == labrastroAdopt {
			result.Status = "adopted"
		}
	}
	actorType, actorID := h.resolveActor(r, uuidToString(a.user), uuidToString(a.ws))
	written.Diagnostics = bundle.diagnostics
	h.publish(event, uuidToString(a.ws), actorType, actorID, map[string]any{"skill": written})
	return result
}
