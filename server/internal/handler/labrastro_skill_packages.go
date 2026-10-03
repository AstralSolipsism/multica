package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type labrastroPackageRequest struct {
	URL        string   `json:"url,omitempty"`
	PreviewID  string   `json:"preview_id,omitempty"`
	Skills     []string `json:"skills,omitempty"`
	All        bool     `json:"all,omitempty"`
	OnConflict string   `json:"on_conflict,omitempty"`
	Apply      bool     `json:"apply,omitempty"`
}
type labrastroPackageSnapshot struct {
	States   []db.LabrastroListSkillStatesRow
	Places   []db.LabrastroSkillPlacement
	Folders  []db.LabrastroSkillFolder
	Packages []db.LabrastroSkillPackage
	Member   db.Member
}
type LabrastroPackagePreview struct {
	PreviewID   string                         `json:"preview_id"`
	Source      map[string]string              `json:"source"`
	Package     *LabrastroSkillPackageResponse `json:"package,omitempty"`
	Candidates  []LabrastroSkillCandidate      `json:"candidates"`
	Diagnostics []SkillImportDiagnostic        `json:"diagnostics"`
}
type LabrastroPackageItemResult struct {
	Path        string                  `json:"path"`
	Status      string                  `json:"status"`
	SkillID     string                  `json:"skill_id,omitempty"`
	Code        string                  `json:"code,omitempty"`
	Reason      string                  `json:"reason,omitempty"`
	Retryable   bool                    `json:"retryable"`
	Diagnostics []SkillImportDiagnostic `json:"diagnostics"`
}
type LabrastroPackageApplyResult struct {
	Package     *LabrastroSkillPackageResponse `json:"package,omitempty"`
	Results     []LabrastroPackageItemResult   `json:"results"`
	Failed      bool                           `json:"failed"`
	Diagnostics []SkillImportDiagnostic        `json:"diagnostics"`
}

func labrastroReadPackageSnapshot(ctx context.Context, q *db.Queries, a labrastroSkillActor) (labrastroPackageSnapshot, error) {
	var s labrastroPackageSnapshot
	var err error
	if s.Member, err = q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: a.user, WorkspaceID: a.ws}); err != nil {
		return s, err
	}
	if s.States, err = q.LabrastroListSkillStates(ctx, a.ws); err != nil {
		return s, err
	}
	if s.Places, err = q.LabrastroListSkillPlacements(ctx, a.ws); err != nil {
		return s, err
	}
	if s.Folders, err = q.LabrastroListSkillFolders(ctx, a.ws); err != nil {
		return s, err
	}
	s.Packages, err = q.LabrastroListSkillPackages(ctx, a.ws)
	return s, err
}
func labrastroStateDigest(s db.LabrastroListSkillStatesRow) string {
	files := [][2]string{}
	_ = json.Unmarshal(s.FileHashes, &files)
	sort.Slice(files, func(i, j int) bool { return files[i][0] < files[j][0] })
	return labrastroJSONHash([]any{s.Name, s.Description, s.ContentHash, files})
}
func labrastroSourceIdentity(config []byte, src *labrastroSkillSource, candidates []LabrastroSkillCandidate) (string, bool) {
	var v struct {
		Origin struct {
			Type  string  `json:"type"`
			URL   string  `json:"source_url"`
			Owner string  `json:"owner"`
			Repo  string  `json:"repo"`
			Path  *string `json:"path"`
		} `json:"origin"`
	}
	if json.Unmarshal(config, &v) != nil {
		return "", false
	}
	o := v.Origin
	if (o.Type != "github" && o.Type != "skills_sh") || !strings.EqualFold(o.Owner, src.spec.owner) || !strings.EqualFold(o.Repo, src.spec.repo) {
		return "", false
	}
	if o.Path != nil {
		return *o.Path, *o.Path == "" || labrastroSafeRepoPath(*o.Path)
	}
	// Legacy skills.sh origins stored a URL slug but no resolved path. Resolve
	// against this source's discovered paths/frontmatter, not the local name.
	// Unlike the old importer's first-match search, adoption rejects ambiguity.
	if o.Type == "skills_sh" {
		owner, repo, slug, err := parseSkillsShParts(o.URL)
		if err != nil || !strings.EqualFold(owner, src.spec.owner) || !strings.EqualFold(repo, src.spec.repo) {
			return "", false
		}
		matches := []string{}
		for _, candidate := range candidates {
			if path.Base(candidate.Path) == slug || candidate.Name == slug {
				matches = append(matches, candidate.Path)
			}
		}
		if len(matches) == 1 {
			return matches[0], true
		}
	}
	return "", false
}
func labrastroFindPackage(s labrastroPackageSnapshot, src *labrastroSkillSource) *db.LabrastroSkillPackage {
	for _, p := range s.Packages {
		if p.OwnerRepo == src.spec.owner+"/"+src.spec.repo && p.Subdirectory == src.spec.skillDir {
			return &p
		}
	}
	return nil
}
func labrastroPreviewFingerprint(a labrastroSkillActor, s labrastroPackageSnapshot, src *labrastroSkillSource, candidates []LabrastroSkillCandidate) string {
	return labrastroJSONHash([]any{uuidToString(a.ws), uuidToString(a.user), src.spec.owner, src.spec.repo, src.spec.ref, src.spec.skillDir, src.commit, candidates, s})
}

func labrastroResolveCandidates(a labrastroSkillActor, s labrastroPackageSnapshot, src *labrastroSkillSource, raw []LabrastroSkillCandidate, p *db.LabrastroSkillPackage) []LabrastroSkillCandidate {
	result := append([]LabrastroSkillCandidate{}, raw...)
	byID := map[string]db.LabrastroListSkillStatesRow{}
	byName := map[string]db.LabrastroListSkillStatesRow{}
	places := map[string]db.LabrastroSkillPlacement{}
	folders := map[pgtype.UUID]db.LabrastroSkillFolder{}
	byPath := map[string]db.LabrastroListSkillStatesRow{}
	present := map[string]bool{}
	for _, f := range s.Folders {
		folders[f.ID] = f
	}
	for _, st := range s.States {
		byID[uuidToString(st.ID)] = st
		byName[st.Name] = st
	}
	for _, place := range s.Places {
		places[uuidToString(place.SkillID)] = place
		if p != nil && place.PackageID == p.ID {
			byPath[place.SourcePath.String] = byID[uuidToString(place.SkillID)]
		}
	}
	for i := range result {
		c := &result[i]
		present[c.Path] = true
		if c.State == "failed" {
			continue
		}
		var target db.LabrastroListSkillStatesRow
		found, own := false, false
		if target, found = byPath[c.Path]; found {
			own = true
		} else {
			matches := []db.LabrastroListSkillStatesRow{}
			for _, st := range s.States {
				if dir, ok := labrastroSourceIdentity(st.Config, src, raw); ok && dir == c.Path {
					matches = append(matches, st)
				}
			}
			if len(matches) > 1 {
				c.State = "conflict"
				c.Conflict = "ambiguous_source"
				c.CanWrite = false
				c.DefaultSelected = false
				continue
			}
			if len(matches) == 1 {
				target = matches[0]
				found = true
				own = true
			} else {
				target, found = byName[sanitizeNullBytes(c.Name)]
			}
		}
		if found {
			c.SkillID = uuidToString(target.ID)
			placement := places[c.SkillID]
			if own && placement.PackageID.Valid && (p == nil || placement.PackageID != p.ID || placement.SourcePath.String != c.Path) {
				c.State = "conflict"
				c.Conflict = "already_packaged"
				c.CanWrite = false
				c.DefaultSelected = false
			} else if own {
				c.CanWrite = labrastroCanManage(target.CreatedBy, a, s.Member)
				if placement.PackageID.Valid {
					c.State = "changed"
					// Local display names (including conflict suffixes) are not
					// source changes. Source frontmatter is still part of ContentHash.
					target.Name = sanitizeNullBytes(c.Name)
					if labrastroStateDigest(target) == c.Digest && folders[placement.FolderID].PackagePath.String == labrastroCandidateFolderPath(c.Path, raw) {
						c.State = "unchanged"
					}
				} else {
					c.State = "adoptable"
				}
				if !c.CanWrite {
					c.Conflict = "forbidden"
				}
			} else {
				c.State = "conflict"
				c.Conflict = "name_conflict"
				c.CanWrite = target.CreatedBy == a.user && !placement.PackageID.Valid
			}
		}
		if p != nil {
			c.DefaultSelected = c.State == "changed"
		}
	}
	if p != nil {
		for source, st := range byPath {
			if !present[source] {
				result = append(result, LabrastroSkillCandidate{Path: source, Name: st.Name, State: "removed", SkillID: uuidToString(st.ID), SharedFiles: []string{}, Diagnostics: []SkillImportDiagnostic{}})
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result
}

func (h *Handler) LabrastroPreviewPackage(w http.ResponseWriter, r *http.Request) {
	h.labrastroPackageOperation(w, r, false, false)
}
func (h *Handler) LabrastroApplyPackage(w http.ResponseWriter, r *http.Request) {
	h.labrastroPackageOperation(w, r, true, false)
}
func (h *Handler) LabrastroRescanPackage(w http.ResponseWriter, r *http.Request) {
	h.labrastroPackageOperation(w, r, false, true)
}
func (h *Handler) labrastroPackageOperation(w http.ResponseWriter, r *http.Request, apply, rescan bool) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	var req labrastroPackageRequest
	if !labrastroDecode(w, r, &req) {
		return
	}
	if req.All && req.Skills != nil {
		writeError(w, 400, "all and skills are mutually exclusive")
		return
	}
	if req.OnConflict != "" && req.OnConflict != "skip" && req.OnConflict != "rename" && req.OnConflict != "overwrite" {
		writeError(w, 400, "on_conflict must be skip, rename or overwrite")
		return
	}
	if req.OnConflict == "" {
		req.OnConflict = "skip"
	}
	var requested pgtype.UUID
	if rescan {
		requested, ok = parseUUIDOrBadRequest(w, chi.URLParam(r, "packageId"), "package_id")
		if !ok {
			return
		}
		p, err := h.Queries.LabrastroGetSkillPackage(r.Context(), db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: requested})
		if err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
		m, err := h.getWorkspaceMember(r.Context(), uuidToString(a.user), uuidToString(a.ws))
		if err == nil {
			err = labrastroRequirePackageOwner(p, a, m)
		}
		if err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
		if req.URL == "" {
			req.URL = p.SourceUrl
		}
		apply = req.Apply
	}
	ctx, cancel := context.WithTimeout(r.Context(), importFetchTimeout)
	defer cancel()
	src, err := newLabrastroSkillSource(ctx, &http.Client{Timeout: 30 * time.Second}, req.URL)
	if err != nil {
		var api *labrastroSkillAPIError
		if errors.As(err, &api) {
			labrastroWriteSkillError(w, err)
		} else {
			writeSkillFetchError(w, ctx, err)
		}
		return
	}
	snap, err := labrastroReadPackageSnapshot(ctx, h.Queries, a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	p := labrastroFindPackage(snap, src)
	if requested.Valid && (p == nil || p.ID != requested) {
		labrastroWriteSkillError(w, labrastroSkillError(409, "source_changed", "rescan cannot change repository identity or subdirectory"))
		return
	}
	if p != nil {
		if err = labrastroRequirePackageOwner(*p, a, snap.Member); err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
	}
	raw, diags, err := src.candidates(ctx)
	// A last-candidate download failure can be returned as a failed row.
	// Cancellation/deadline must win over both that row and fingerprint checks.
	if ctx.Err() != nil {
		labrastroWriteSkillError(w, labrastroSkillError(http.StatusGatewayTimeout, "source_timeout", "skill package source scan timed out or was canceled; preview again"))
		return
	}
	if err != nil {
		writeSkillFetchError(w, ctx, err)
		return
	}
	if diags == nil {
		diags = []SkillImportDiagnostic{}
	}
	candidates := labrastroResolveCandidates(a, snap, src, raw, p)
	fingerprint := labrastroPreviewFingerprint(a, snap, src, candidates)
	if !apply {
		preview := LabrastroPackagePreview{PreviewID: labrastroSignPreview(fingerprint, time.Now().Add(15*time.Minute).Unix()), Source: map[string]string{"url": src.URL, "owner_repo": src.spec.owner + "/" + src.spec.repo, "subdirectory": src.spec.skillDir, "ref": src.spec.ref, "revision": src.commit}, Candidates: candidates, Diagnostics: diags}
		if p != nil {
			response := labrastroPackageResponse(*p)
			preview.Package = &response
		}
		writeJSON(w, 200, preview)
		return
	}
	if !labrastroValidatePreview(req.PreviewID, fingerprint) {
		// A valid token with an incomplete re-scan cannot prove source or
		// permission changes. Matching previews with failed candidates still
		// proceed to best-effort item reporting; invalid/expired tokens stay 409.
		hash, _, _ := strings.Cut(req.PreviewID, ".")
		if labrastroValidatePreview(req.PreviewID, hash) {
			for _, c := range raw {
				if c.State != "failed" {
					continue
				}
				for _, d := range c.Diagnostics {
					if d.Retryable {
						writeSkillFetchError(w, ctx, fmt.Errorf("%w: could not revalidate candidate %q: %s; preview again", errImportSourceUnavailable, c.Path, d.Message))
						return
					}
				}
			}
		}
		labrastroWriteSkillError(w, labrastroStalePreview())
		return
	}
	selected := map[string]bool{}
	for _, p := range req.Skills {
		selected[p] = true
	}
	known := map[string]bool{}
	for _, c := range candidates {
		known[c.Path] = true
		if req.All || req.Skills == nil && c.DefaultSelected {
			selected[c.Path] = true
		}
	}
	for p := range selected {
		if !known[p] {
			writeError(w, 400, "selected skill path is not in this preview")
			return
		}
	}
	// Re-read under the workspace lock after network IO. The client never
	// supplies permission claims, a target id, candidate content or provenance.
	tx, q, _, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	current, err := labrastroReadPackageSnapshot(ctx, q, a)
	if err == nil && labrastroPreviewFingerprint(a, current, src, labrastroResolveCandidates(a, current, src, raw, labrastroFindPackage(current, src))) != fingerprint {
		err = labrastroStalePreview()
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	if len(selected) == 0 && p == nil {
		tx.Rollback(ctx)
		results := []LabrastroPackageItemResult{}
		for _, c := range candidates {
			results = append(results, LabrastroPackageItemResult{Path: c.Path, Status: "skipped", Code: "not_selected", Diagnostics: c.Diagnostics})
		}
		writeJSON(w, 200, LabrastroPackageApplyResult{Results: results, Diagnostics: diags})
		return
	}
	cache := labrastroCandidateCache(raw)
	if p == nil {
		rootID, packageID := labrastroNewID(), labrastroNewID()
		name := labrastroPackageRootName(src.spec.owner+"/"+src.spec.repo, current.Folders)
		_, err = q.LabrastroCreateSkillFolder(ctx, db.LabrastroCreateSkillFolderParams{ID: rootID, WorkspaceID: a.ws, Name: name, PackageID: packageID, PackagePath: pgtype.Text{String: "", Valid: true}})
		if err == nil {
			created, e := q.LabrastroCreateSkillPackage(ctx, db.LabrastroCreateSkillPackageParams{ID: packageID, WorkspaceID: a.ws, OwnerRepo: src.spec.owner + "/" + src.spec.repo, Subdirectory: src.spec.skillDir, SourceUrl: src.URL, SourceRef: src.spec.ref, RootFolderID: rootID, CreatedBy: a.user, Candidates: cache})
			p = &created
			err = e
		}
	} else {
		updated, e := q.LabrastroApplySkillPackage(ctx, db.LabrastroApplySkillPackageParams{WorkspaceID: a.ws, ID: p.ID, SourceUrl: src.URL, SourceRef: src.spec.ref, Candidates: cache})
		p = &updated
		err = e
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	response := labrastroPackageResponse(*p)
	report := LabrastroPackageApplyResult{Package: &response, Results: []LabrastroPackageItemResult{}, Diagnostics: diags}
	for _, c := range candidates {
		item := LabrastroPackageItemResult{Path: c.Path, SkillID: c.SkillID, Status: "skipped", Diagnostics: c.Diagnostics}
		if c.State == "removed" {
			item.Status = "retained"
			item.Code = "source_removed"
		} else if !selected[c.Path] {
			item.Code = "not_selected"
		} else if c.State == "unchanged" {
			item.Status = "unchanged"
		} else {
			item = h.labrastroApplyCandidate(ctx, r, a, *p, src, snap, raw, c, req)
		}
		if item.Status == "failed" {
			report.Failed = true
		}
		report.Results = append(report.Results, item)
	}
	writeJSON(w, 200, report)
}

func labrastroCandidateCache(candidates []LabrastroSkillCandidate) []byte {
	type summary struct {
		Path        string `json:"path"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Digest      string `json:"digest,omitempty"`
	}
	rows := []summary{}
	for _, c := range candidates {
		rows = append(rows, summary{c.Path, c.Name, c.Description, c.Digest})
	}
	body, _ := json.Marshal(rows)
	return body
}

func (h *Handler) labrastroApplyCandidate(ctx context.Context, r *http.Request, a labrastroSkillActor, p db.LabrastroSkillPackage, src *labrastroSkillSource, snap labrastroPackageSnapshot, raw []LabrastroSkillCandidate, c LabrastroSkillCandidate, req labrastroPackageRequest) LabrastroPackageItemResult {
	result := LabrastroPackageItemResult{Path: c.Path, Status: "failed", SkillID: c.SkillID, Diagnostics: c.Diagnostics}
	fail := func(code, reason string, retry bool) LabrastroPackageItemResult {
		result.Code = code
		result.Reason = reason
		result.Retryable = retry
		return result
	}
	if err := ctx.Err(); err != nil {
		return fail("source_timeout", err.Error(), true)
	}
	if c.State == "failed" {
		if len(c.Diagnostics) > 0 {
			d := c.Diagnostics[0]
			return fail(d.Code, d.Message, d.Retryable)
		}
		return fail("candidate_failed", "candidate could not be fetched; preview again", true)
	}
	if c.Conflict == "already_packaged" || c.Conflict == "ambiguous_source" {
		if req.OnConflict == "skip" {
			result.Status = "skipped"
		}
		return fail(c.Conflict, "detach from the other package or resolve the ambiguous source first", false)
	}
	if c.State == "conflict" && req.OnConflict == "skip" {
		result.Status = "skipped"
		return fail(c.Conflict, "existing skill left unchanged", false)
	}
	if c.Conflict == "forbidden" && req.Skills == nil && !req.All {
		result.Status = "skipped"
		return fail("forbidden", "permission required to adopt or update this skill", false)
	}
	bundle, err := src.bundle(ctx, c.Path)
	if err != nil {
		var detail *labrastroImportError
		if errors.As(err, &detail) {
			result.Diagnostics = append(result.Diagnostics, detail.Diagnostic)
			return fail(detail.Diagnostic.Code, err.Error(), detail.Diagnostic.Retryable)
		}
		return fail("source_unavailable", err.Error(), !isCapError(err))
	}
	if labrastroBundleDigest(bundle) != c.Digest {
		return fail("source_changed", "candidate changed since preview", true)
	}
	tx, q, m, err := h.labrastroSkillTx(ctx, a)
	if err != nil {
		return fail("permission_changed", "could not enter workspace transaction", true)
	}
	defer tx.Rollback(ctx)
	current, err := q.LabrastroGetSkillPackage(ctx, db.LabrastroGetSkillPackageParams{WorkspaceID: a.ws, ID: p.ID})
	if err != nil {
		return fail("preview_stale", "package was removed", true)
	}
	if current.Revision != p.Revision || current.SourceUrl != p.SourceUrl || current.SourceRef != p.SourceRef {
		return fail("preview_stale", "package source changed during apply", true)
	}
	if err = labrastroRequirePackageOwner(current, a, m); err != nil {
		return fail("forbidden", err.Error(), false)
	}
	name := sanitizeNullBytes(bundle.name)
	var target db.Skill
	var original db.LabrastroListSkillStatesRow
	// Rename creates an independent skill. A name-only collision does not
	// grant or require permission to modify the existing skill or its placement.
	hasTarget := c.SkillID != "" && !(c.Conflict == "name_conflict" && req.OnConflict == "rename")
	overwrite := c.State == "conflict" && req.OnConflict == "overwrite"
	if hasTarget {
		target, err = q.LabrastroLockSkill(ctx, db.LabrastroLockSkillParams{WorkspaceID: a.ws, ID: parseUUID(c.SkillID)})
		if err != nil {
			return fail("preview_stale", "target disappeared", true)
		}
		for _, st := range snap.States {
			if st.ID == target.ID {
				original = st
				break
			}
		}
		states, e := q.LabrastroListSkillStates(ctx, a.ws)
		if e != nil {
			return fail("operation_failed", "could not recheck target", true)
		}
		for _, st := range states {
			if st.ID == target.ID && labrastroJSONHash(st) != labrastroJSONHash(original) {
				return fail("preview_stale", "target changed since preview", true)
			}
		}
		places, e := q.LabrastroListSkillPlacements(ctx, a.ws)
		if e != nil {
			return fail("operation_failed", "could not recheck placement", true)
		}
		for _, place := range places {
			if place.SkillID == target.ID && place.PackageID.Valid && (overwrite || place.PackageID != p.ID || place.SourcePath.String != c.Path) {
				return fail("already_packaged", "target belongs to another package or path", false)
			}
		}
		if labrastroPlacementFor(target.ID, places) != labrastroPlacementFor(target.ID, snap.Places) {
			return fail("preview_stale", "target placement changed since preview", true)
		}
		if overwrite {
			if !canOverwriteSkillByLocalImport(uuidToString(a.user), target) {
				return fail("forbidden", "only the skill creator can overwrite a different source", false)
			}
		} else if !labrastroCanManage(target.CreatedBy, a, m) {
			return fail("forbidden", "only the skill creator or workspace admin can adopt/update", false)
		}
		if c.State == "changed" || c.State == "adoptable" {
			// Use the last successfully persisted source frontmatter. Package
			// summaries also advance for failed/deselected items, so comparing
			// only their names would forget an upstream rename on a later retry.
			previousName, _ := src.metadata(target.Content, c.Path)
			if sanitizeNullBytes(previousName) == name {
				name = target.Name
			}
		}
	}
	if !hasTarget && c.State == "conflict" && req.OnConflict == "rename" {
		for suffix := 2; suffix < maxImportRenameAttempts+2; suffix++ {
			candidate := fmt.Sprintf("%s-%d", name, suffix)
			_, err = q.GetSkillByWorkspaceAndName(ctx, db.GetSkillByWorkspaceAndNameParams{WorkspaceID: a.ws, Name: candidate})
			if errors.Is(err, pgx.ErrNoRows) {
				name = candidate
				break
			}
			if err != nil {
				return fail("operation_failed", "could not choose a new name", true)
			}
		}
	}
	folder, err := labrastroPackageFolder(ctx, q, a.ws, p, c.Path, raw)
	if err != nil {
		return fail("folder_conflict", "could not place candidate in the managed tree", false)
	}
	var written SkillWithFilesResponse
	if hasTarget {
		allow := func(uid string, s db.Skill) bool {
			if overwrite {
				return canOverwriteSkillByLocalImport(uid, s)
			}
			return labrastroCanManage(s.CreatedBy, a, m)
		}
		written, err = overwriteSkillWithFilesInTx(ctx, q, skillOverwriteInput{WorkspaceID: a.ws, TargetSkillID: target.ID, UserID: uuidToString(a.user), NewName: name, AllowOverwrite: allow, Description: bundle.description, Content: bundle.content, Config: mergeSkillConfigOrigin(target.Config, bundle.origin), Files: importedSkillFileRequests(bundle)})
	} else {
		written, err = createSkillWithFilesInTx(ctx, q, skillCreateInput{WorkspaceID: a.ws, CreatorID: a.user, Name: name, Description: bundle.description, Content: bundle.content, Config: map[string]any{"origin": bundle.origin}, Files: importedSkillFileRequests(bundle)})
	}
	if err != nil {
		if isUniqueViolation(err) || errors.Is(err, errSkillOverwriteNameConflict) {
			return fail("name_conflict", "another skill has the imported name", false)
		}
		return fail("item_failed", "skill contents and placement rolled back", true)
	}
	if err = q.LabrastroPlaceSkill(ctx, db.LabrastroPlaceSkillParams{WorkspaceID: a.ws, SkillID: parseUUID(written.ID), FolderID: folder, PackageID: p.ID, SourcePath: pgtype.Text{String: c.Path, Valid: true}}); err != nil {
		return fail("placement_conflict", "skill contents and placement rolled back", true)
	}
	if err = q.LabrastroPruneSkillPackageFolders(ctx, db.LabrastroPruneSkillPackageFoldersParams{WorkspaceID: a.ws, PackageID: p.ID, KeepRoot: true}); err != nil {
		return fail("placement_conflict", "skill contents and placement rolled back", true)
	}
	if err = tx.Commit(ctx); err != nil {
		return fail("item_failed", "skill transaction did not commit; preview again", true)
	}
	result.SkillID = written.ID
	result.Status = "created"
	event := protocol.EventSkillCreated
	if hasTarget {
		result.Status = "updated"
		event = protocol.EventSkillUpdated
		if c.State == "adoptable" {
			result.Status = "adopted"
		}
	}
	actorType, actorID := h.resolveActor(r, uuidToString(a.user), uuidToString(a.ws))
	written.Diagnostics = bundle.diagnostics
	h.publish(event, uuidToString(a.ws), actorType, actorID, map[string]any{"skill": written})
	return result
}

func labrastroPlacementFor(id pgtype.UUID, places []db.LabrastroSkillPlacement) db.LabrastroSkillPlacement {
	for _, p := range places {
		if p.SkillID == id {
			return p
		}
	}
	return db.LabrastroSkillPlacement{}
}

func labrastroPackageRootName(base string, folders []db.LabrastroSkillFolder) string {
	names := map[string]bool{}
	for _, f := range folders {
		if !f.ParentID.Valid {
			names[f.Name] = true
		}
	}
	name := base
	for suffix := 2; names[name]; suffix++ {
		name = fmt.Sprintf("%s (%d)", base, suffix)
	}
	return name
}

func labrastroCommonCandidatePrefix(candidates []LabrastroSkillCandidate) string {
	if len(candidates) == 0 {
		return ""
	}
	prefix := path.Dir(candidates[0].Path)
	if prefix == "." {
		prefix = ""
	}
	for _, c := range candidates[1:] {
		dir := path.Dir(c.Path)
		if dir == "." {
			dir = ""
		}
		for prefix != "" && dir != prefix && !strings.HasPrefix(dir, prefix+"/") {
			prefix = path.Dir(prefix)
			if prefix == "." {
				prefix = ""
			}
		}
	}
	return prefix
}
func labrastroCandidateFolderPath(dir string, candidates []LabrastroSkillCandidate) string {
	parentDir := path.Dir(dir)
	if parentDir == "." {
		parentDir = ""
	}
	prefix := labrastroCommonCandidatePrefix(candidates)
	return strings.TrimPrefix(strings.TrimPrefix(parentDir, prefix), "/")
}

func labrastroPackageFolder(ctx context.Context, q *db.Queries, ws pgtype.UUID, p db.LabrastroSkillPackage, dir string, candidates []LabrastroSkillCandidate) (pgtype.UUID, error) {
	relative := labrastroCandidateFolderPath(dir, candidates)
	parent := p.RootFolderID
	if relative == "" {
		return parent, nil
	}
	folders, err := q.LabrastroListSkillFolders(ctx, ws)
	if err != nil {
		return parent, err
	}
	known := map[string]db.LabrastroSkillFolder{}
	for _, f := range folders {
		if f.PackageID == p.ID {
			known[f.PackagePath.String] = f
		}
	}
	current := ""
	for _, part := range strings.Split(relative, "/") {
		current = path.Join(current, part)
		if f, ok := known[current]; ok {
			parent = f.ID
			continue
		}
		f, err := q.LabrastroCreateSkillFolder(ctx, db.LabrastroCreateSkillFolderParams{ID: labrastroNewID(), WorkspaceID: ws, ParentID: parent, Name: part, PackageID: p.ID, PackagePath: pgtype.Text{String: current, Valid: true}})
		if err != nil {
			return parent, err
		}
		parent = f.ID
	}
	return parent, nil
}
