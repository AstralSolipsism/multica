package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
func labrastroSourceIdentity(config []byte, src *labrastroSkillSource, legacyPaths map[string][]string) (string, bool) {
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
		matches := legacyPaths[slug]
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
	// Resolve provenance once per skill, including legacy slug ambiguity.
	legacyPaths := map[string][]string{}
	for _, c := range raw {
		base := path.Base(c.Path)
		legacyPaths[base] = append(legacyPaths[base], c.Path)
		if c.Name != base {
			legacyPaths[c.Name] = append(legacyPaths[c.Name], c.Path)
		}
	}
	bySource := map[string][]db.LabrastroListSkillStatesRow{}
	for _, st := range s.States {
		if dir, ok := labrastroSourceIdentity(st.Config, src, legacyPaths); ok {
			bySource[dir] = append(bySource[dir], st)
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
			matches := bySource[c.Path]
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
	req, requested, apply, ok := h.labrastroPackageInput(w, r, a, apply, rescan)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), importFetchTimeout)
	defer cancel()
	src, err := newLabrastroSkillSource(ctx, &http.Client{Timeout: 30 * time.Second}, req.URL, uuidToString(a.ws))
	if err != nil {
		labrastroWritePackageSourceError(w, ctx, err)
		return
	}
	scan, ok := h.labrastroScanPackage(w, ctx, a, src, requested)
	if !ok {
		return
	}
	if !apply {
		writeJSON(w, 200, scan.preview())
		return
	}
	if err = labrastroCheckPackagePreview(req.PreviewID, scan.fingerprint, scan.raw); err != nil {
		labrastroWritePackageSourceError(w, ctx, err)
		return
	}
	selected, err := labrastroSelectCandidates(req, scan.candidates)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	p, err := h.labrastroCommitPackageMetadata(ctx, a, scan, len(selected) > 0)
	if err != nil {
		labrastroWritePackageError(w, ctx, err)
		return
	}
	writeJSON(w, 200, h.labrastroApplyPackageItems(ctx, r, a, p, scan, selected, req))
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
