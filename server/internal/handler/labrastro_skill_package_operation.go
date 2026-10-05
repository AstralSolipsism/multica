package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type labrastroPackageScan struct {
	src             *labrastroSkillSource
	snapshot        labrastroPackageSnapshot
	packageRow      *db.LabrastroSkillPackage
	raw, candidates []LabrastroSkillCandidate
	diagnostics     []SkillImportDiagnostic
	fingerprint     string
}

func (h *Handler) labrastroPackageInput(w http.ResponseWriter, r *http.Request, a labrastroSkillActor, apply, rescan bool) (labrastroPackageRequest, pgtype.UUID, bool, bool) {
	var req labrastroPackageRequest
	var requested pgtype.UUID
	if !labrastroDecode(w, r, &req) {
		return req, requested, apply, false
	}
	if req.All && req.Skills != nil {
		writeError(w, 400, "all and skills are mutually exclusive")
		return req, requested, apply, false
	}
	switch req.OnConflict {
	case "":
		req.OnConflict = "skip"
	case "skip", "rename", "overwrite":
	default:
		writeError(w, 400, "on_conflict must be skip, rename or overwrite")
		return req, requested, apply, false
	}
	if !rescan {
		return req, requested, apply, true
	}
	var ok bool
	requested, ok = parseUUIDOrBadRequest(w, chi.URLParam(r, "packageId"), "package_id")
	if !ok {
		return req, requested, apply, false
	}
	p, err := h.Queries.LabrastroGetSkillPackage(r.Context(), db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: requested})
	if err == nil {
		var member db.Member
		member, err = h.getWorkspaceMember(r.Context(), uuidToString(a.user), uuidToString(a.ws))
		if err == nil {
			err = labrastroRequirePackageOwner(p, a, member)
		}
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return req, requested, apply, false
	}
	if req.URL == "" {
		req.URL = p.SourceUrl
	}
	return req, requested, req.Apply, true
}

func labrastroWritePackageSourceError(w http.ResponseWriter, ctx context.Context, err error) {
	var api *labrastroSkillAPIError
	if errors.As(err, &api) {
		labrastroWriteSkillError(w, err)
	} else {
		writeSkillFetchError(w, ctx, err)
	}
}

func labrastroWritePackageError(w http.ResponseWriter, ctx context.Context, err error) {
	// Cancellation wins over database errors and stale-preview diagnoses.
	if ctx.Err() != nil {
		err = labrastroSkillError(http.StatusGatewayTimeout, "source_timeout", "skill package request timed out or was canceled; preview again")
	}
	labrastroWriteSkillError(w, err)
}

func labrastroAuthorizePackage(a labrastroSkillActor, snap labrastroPackageSnapshot, p *db.LabrastroSkillPackage, requested pgtype.UUID) error {
	if requested.Valid && (p == nil || p.ID != requested) {
		return labrastroSkillError(409, "source_changed", "rescan cannot change repository identity or subdirectory")
	}
	if p != nil {
		return labrastroRequirePackageOwner(*p, a, snap.Member)
	}
	return nil
}

func (h *Handler) labrastroScanPackage(w http.ResponseWriter, ctx context.Context, a labrastroSkillActor, src *labrastroSkillSource, requested pgtype.UUID) (labrastroPackageScan, bool) {
	scan := labrastroPackageScan{src: src}
	snap, err := labrastroReadPackageSnapshot(ctx, h.Queries, a)
	if err != nil {
		labrastroWritePackageError(w, ctx, err)
		return scan, false
	}
	p := labrastroFindPackage(snap, src)
	if err = labrastroAuthorizePackage(a, snap, p, requested); err != nil {
		labrastroWriteSkillError(w, err)
		return scan, false
	}
	raw, diags, err := src.candidates(ctx)
	// A last-candidate download failure can be returned as a failed row.
	if ctx.Err() != nil {
		labrastroWritePackageError(w, ctx, ctx.Err())
		return scan, false
	}
	if err != nil {
		writeSkillFetchError(w, ctx, err)
		return scan, false
	}
	if diags == nil {
		diags = []SkillImportDiagnostic{}
	}
	scan.snapshot, scan.packageRow, scan.raw, scan.diagnostics = snap, p, raw, diags
	scan.candidates = labrastroResolveCandidates(a, snap, src, raw, p)
	scan.fingerprint = labrastroPreviewFingerprint(a, snap, src, scan.candidates)
	return scan, true
}

func (s labrastroPackageScan) preview() LabrastroPackagePreview {
	src := s.src
	preview := LabrastroPackagePreview{PreviewID: labrastroSignPreview(s.fingerprint, time.Now().Add(15*time.Minute).Unix()), Source: map[string]string{"url": src.URL, "owner_repo": src.spec.owner + "/" + src.spec.repo, "subdirectory": src.spec.skillDir, "ref": src.spec.ref, "revision": src.commit}, Candidates: s.candidates, Diagnostics: s.diagnostics}
	if s.packageRow != nil {
		response := labrastroPackageResponse(*s.packageRow)
		preview.Package = &response
	}
	return preview
}

func labrastroCheckPackagePreview(token, fingerprint string, raw []LabrastroSkillCandidate) error {
	if labrastroValidatePreview(token, fingerprint) {
		return nil
	}
	// An incomplete rescan cannot establish a source/permission change. Only
	// a valid signed token can receive this transient failure classification.
	hash, _, _ := strings.Cut(token, ".")
	if labrastroValidatePreview(token, hash) {
		for _, c := range raw {
			if c.State != "failed" {
				continue
			}
			for _, d := range c.Diagnostics {
				if d.Retryable {
					return fmt.Errorf("%w: could not revalidate candidate %q: %s; preview again", errImportSourceUnavailable, c.Path, d.Message)
				}
			}
		}
	}
	return labrastroStalePreview()
}

func labrastroSelectCandidates(req labrastroPackageRequest, candidates []LabrastroSkillCandidate) (map[string]bool, error) {
	selected, known := map[string]bool{}, map[string]bool{}
	for _, p := range req.Skills {
		selected[p] = true
	}
	for _, c := range candidates {
		known[c.Path] = true
		if req.All || req.Skills == nil && c.DefaultSelected {
			selected[c.Path] = true
		}
	}
	for p := range selected {
		if !known[p] {
			return nil, fmt.Errorf("selected skill path is not in this preview")
		}
	}
	return selected, nil
}

func (h *Handler) labrastroCommitPackageMetadata(ctx context.Context, a labrastroSkillActor, scan labrastroPackageScan, selected bool) (*db.LabrastroSkillPackage, error) {
	// Re-read under the workspace lock after network IO; never trust client
	// permission claims, target IDs, candidate contents or provenance.
	tx, q, _, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	current, err := labrastroReadPackageSnapshot(ctx, q, a)
	if err != nil {
		return nil, err
	}
	src := scan.src
	p := labrastroFindPackage(current, src)
	candidates := labrastroResolveCandidates(a, current, src, scan.raw, p)
	if labrastroPreviewFingerprint(a, current, src, candidates) != scan.fingerprint {
		return nil, labrastroStalePreview()
	}
	if !selected && p == nil {
		return nil, nil
	}
	p, err = labrastroWritePackageMetadata(ctx, q, a, src, current.Folders, p, scan.raw)
	if err == nil {
		err = tx.Commit(ctx)
	}
	return p, err
}

func labrastroWritePackageMetadata(ctx context.Context, q *db.Queries, a labrastroSkillActor, src *labrastroSkillSource, folders []db.LabrastroSkillFolder, p *db.LabrastroSkillPackage, raw []LabrastroSkillCandidate) (*db.LabrastroSkillPackage, error) {
	cache := labrastroCandidateCache(raw)
	if p != nil {
		updated, err := q.LabrastroApplySkillPackage(ctx, db.LabrastroApplySkillPackageParams{WorkspaceID: a.ws, ID: p.ID, SourceUrl: src.URL, SourceRef: src.spec.ref, Candidates: cache})
		return &updated, err
	}
	rootID, packageID := labrastroNewID(), labrastroNewID()
	name := labrastroPackageRootName(src.spec.owner+"/"+src.spec.repo, folders)
	_, err := q.LabrastroCreateSkillFolder(ctx, db.LabrastroCreateSkillFolderParams{ID: rootID, WorkspaceID: a.ws, Name: name, PackageID: packageID, PackagePath: pgtype.Text{String: "", Valid: true}})
	if err != nil {
		return nil, err
	}
	created, err := q.LabrastroCreateSkillPackage(ctx, db.LabrastroCreateSkillPackageParams{ID: packageID, WorkspaceID: a.ws, OwnerRepo: src.spec.owner + "/" + src.spec.repo, Subdirectory: src.spec.skillDir, SourceUrl: src.URL, SourceRef: src.spec.ref, RootFolderID: rootID, CreatedBy: a.user, Candidates: cache})
	return &created, err
}

func (h *Handler) labrastroApplyPackageItems(ctx context.Context, r *http.Request, a labrastroSkillActor, p *db.LabrastroSkillPackage, scan labrastroPackageScan, selected map[string]bool, req labrastroPackageRequest) LabrastroPackageApplyResult {
	report := LabrastroPackageApplyResult{Results: []LabrastroPackageItemResult{}, Diagnostics: scan.diagnostics}
	if p != nil {
		response := labrastroPackageResponse(*p)
		report.Package = &response
	}
	index := labrastroIndexTargets(scan.snapshot)
	for _, c := range scan.candidates {
		item := LabrastroPackageItemResult{Path: c.Path, SkillID: c.SkillID, Status: "skipped", Diagnostics: c.Diagnostics}
		switch {
		case p == nil:
			item.SkillID, item.Code = "", "not_selected"
		case c.State == "removed":
			item.Status, item.Code = "retained", "source_removed"
		case !selected[c.Path]:
			item.Code = "not_selected"
		case c.State == "unchanged":
			item.Status = "unchanged"
		default:
			item = h.labrastroApplyCandidate(ctx, r, a, *p, scan.src, index, scan.raw, c, req)
		}
		report.Failed = report.Failed || item.Status == "failed"
		report.Results = append(report.Results, item)
	}
	return report
}
