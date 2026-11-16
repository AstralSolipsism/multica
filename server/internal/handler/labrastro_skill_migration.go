package handler

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type labrastroOrganizationSnapshot struct {
	SchemaVersion     int                           `json:"schema_version"`
	ExportedAt        time.Time                     `json:"exported_at"`
	SourceWorkspaceID pgtype.UUID                   `json:"source_workspace_id"`
	Folders           []labrastroMigrationFolder    `json:"folders"`
	Packages          []labrastroMigrationPackage   `json:"packages"`
	Placements        []labrastroMigrationPlacement `json:"placements"`
}
type labrastroMigrationFolder struct {
	ID          pgtype.UUID `json:"id"`
	ParentID    pgtype.UUID `json:"parent_id"`
	Name        string      `json:"name"`
	PackageID   pgtype.UUID `json:"package_id"`
	PackagePath *string     `json:"package_path"`
}
type labrastroMigrationPackage struct {
	ID           pgtype.UUID                      `json:"id"`
	OwnerRepo    string                           `json:"owner_repo"`
	Subdirectory string                           `json:"subdirectory"`
	SourceURL    string                           `json:"source_url"`
	Ref          string                           `json:"ref"`
	RootFolderID pgtype.UUID                      `json:"root_folder_id"`
	Candidates   []labrastroSkillCandidateSummary `json:"candidates"`
}

// Only provenance fields cross the export boundary, never arbitrary config.
type labrastroMigrationOrigin struct {
	Type      string  `json:"type"`
	Owner     string  `json:"owner,omitempty"`
	Repo      string  `json:"repo,omitempty"`
	Path      *string `json:"path,omitempty"`
	Ref       string  `json:"ref,omitempty"`
	SourceURL string  `json:"source_url,omitempty"`
	Skill     string  `json:"skill,omitempty"`
	Slug      string  `json:"slug,omitempty"`
	Version   string  `json:"version,omitempty"`
}
type labrastroMigrationSkill struct {
	Name   string                    `json:"name"`
	Origin *labrastroMigrationOrigin `json:"origin"`
	Digest string                    `json:"digest"`
}
type labrastroMigrationPlacement struct {
	SkillID    pgtype.UUID             `json:"skill_id"`
	FolderID   pgtype.UUID             `json:"folder_id"`
	PackageID  pgtype.UUID             `json:"package_id"`
	SourcePath *string                 `json:"source_path"`
	Skill      labrastroMigrationSkill `json:"skill"`
}
type labrastroMigrationFolderPlan struct {
	labrastroMigrationFolder
	SourceID pgtype.UUID `json:"source_id"`
	Action   string      `json:"action"`
}
type labrastroMigrationPackagePlan struct {
	labrastroMigrationPackage
	SourceID pgtype.UUID `json:"source_id"`
	Action   string      `json:"action"`
}
type labrastroMigrationPlacementPlan struct {
	labrastroMigrationPlacement
	SourceSkillID pgtype.UUID `json:"source_skill_id"`
	Action        string      `json:"action"`
	Code          string      `json:"code,omitempty"`
	FromFolderID  pgtype.UUID `json:"from_folder_id"`
	FromPath      string      `json:"from_path"`
	ToPath        string      `json:"to_path"`
}
type labrastroMigrationConflict struct {
	Kind     string      `json:"kind"`
	SourceID pgtype.UUID `json:"source_id"`
	Code     string      `json:"code"`
	Message  string      `json:"message"`
}
type labrastroMigrationPlan struct {
	PreviewID  string                            `json:"preview_id,omitempty"`
	CanApply   bool                              `json:"can_apply"`
	Changed    bool                              `json:"changed"`
	Summary    map[string]int                    `json:"summary"`
	Folders    []labrastroMigrationFolderPlan    `json:"folders"`
	Packages   []labrastroMigrationPackagePlan   `json:"packages"`
	Placements []labrastroMigrationPlacementPlan `json:"placements"`
	Conflicts  []labrastroMigrationConflict      `json:"conflicts"`
}

func labrastroMigrationText(p *string) pgtype.Text {
	if p == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *p, Valid: true}
}
func labrastroMigrationString(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}
func labrastroMigrationOriginFromConfig(config []byte) *labrastroMigrationOrigin {
	var v struct {
		Origin *labrastroMigrationOrigin `json:"origin"`
	}
	_ = json.Unmarshal(config, &v)
	if v.Origin != nil && v.Origin.SourceURL != "" {
		// Credentials in a hand-edited provenance URL must never be exported.
		u, err := url.Parse(v.Origin.SourceURL)
		if err != nil {
			v.Origin.SourceURL = ""
		} else {
			u.User, u.RawQuery, u.Fragment = nil, "", ""
			v.Origin.SourceURL = u.String()
		}
	}
	return v.Origin
}
func (h *Handler) labrastroReadOrganization(ctx context.Context, a labrastroSkillActor) (labrastroPackageSnapshot, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return labrastroPackageSnapshot{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); err != nil {
		return labrastroPackageSnapshot{}, err
	}
	s, err := labrastroReadPackageSnapshot(ctx, h.Queries.WithTx(tx), a)
	if err == nil {
		err = tx.Commit(ctx)
	}
	return s, err
}
func (h *Handler) LabrastroExportSkillOrganization(w http.ResponseWriter, r *http.Request) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	s, err := h.labrastroReadOrganization(r.Context(), a)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	out := labrastroOrganizationSnapshot{SchemaVersion: 1, ExportedAt: time.Now().UTC(), SourceWorkspaceID: a.ws, Folders: []labrastroMigrationFolder{}, Packages: []labrastroMigrationPackage{}, Placements: []labrastroMigrationPlacement{}}
	for _, f := range s.Folders {
		out.Folders = append(out.Folders, labrastroMigrationFolder{f.ID, f.ParentID, f.Name, f.PackageID, labrastroMigrationString(f.PackagePath)})
	}
	for _, p := range s.Packages {
		item := labrastroMigrationPackage{ID: p.ID, OwnerRepo: p.OwnerRepo, Subdirectory: p.Subdirectory, SourceURL: p.SourceUrl, Ref: p.SourceRef, RootFolderID: p.RootFolderID}
		if err := json.Unmarshal(p.Candidates, &item.Candidates); err != nil {
			labrastroWriteSkillError(w, err)
			return
		}
		out.Packages = append(out.Packages, item)
	}
	states := map[pgtype.UUID]db.LabrastroListSkillStatesRow{}
	for _, st := range s.States {
		states[st.ID] = st
	}
	for _, p := range s.Places {
		st := states[p.SkillID]
		out.Placements = append(out.Placements, labrastroMigrationPlacement{p.SkillID, p.FolderID, p.PackageID, labrastroMigrationString(p.SourcePath), labrastroMigrationSkill{st.Name, labrastroMigrationOriginFromConfig(st.Config), labrastroStateDigest(st)}})
	}
	// Reject corrupt stored metadata instead of producing an unusable archive.
	if _, err := labrastroValidateOrganization(out); err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
func labrastroMigrationUUID(id pgtype.UUID) bool { return id.Valid && id.Bytes != [16]byte{} }
func labrastroMigrationPackageKey(owner, dir string) string {
	return strings.ToLower(owner) + "\x00" + dir
}
func labrastroMigrationSibling(parent pgtype.UUID, name string) string {
	return uuidToString(parent) + "\x00" + name
}
func labrastroMigrationPath(pkg pgtype.UUID, p string) string { return uuidToString(pkg) + "\x00" + p }

func labrastroValidateOrganization(s labrastroOrganizationSnapshot) ([]labrastroMigrationFolder, error) {
	invalid := func(code, msg string) ([]labrastroMigrationFolder, error) {
		return nil, labrastroSkillError(422, code, msg)
	}
	if s.SchemaVersion != 1 || s.ExportedAt.IsZero() || !labrastroMigrationUUID(s.SourceWorkspaceID) || s.Folders == nil || s.Packages == nil || s.Placements == nil {
		return invalid("invalid_snapshot", "expected a complete schema_version 1 snapshot")
	}
	packages := map[pgtype.UUID]labrastroMigrationPackage{}
	packageKeys := map[string]bool{}
	for _, p := range s.Packages {
		key := labrastroMigrationPackageKey(p.OwnerRepo, p.Subdirectory)
		if !labrastroMigrationUUID(p.ID) || packages[p.ID].ID.Valid || packageKeys[key] {
			return invalid("invalid_snapshot", "invalid or duplicate package identity")
		}
		spec, err := labrastroParsePackageURL(p.SourceURL)
		suffix := p.Ref
		if p.Subdirectory != "" {
			suffix += "/" + p.Subdirectory
		}
		// The snapshot already records the resolved slash-containing ref. No network resolution.
		if err != nil || !strings.EqualFold(spec.owner+"/"+spec.repo, p.OwnerRepo) || p.Ref == "" || !labrastroSafeRepoPath(p.Ref) || (p.Subdirectory != "" && !labrastroSafeRepoPath(p.Subdirectory)) || strings.Join(spec.refSegments, "/") != suffix {
			return invalid("invalid_snapshot", "package URL does not agree with repository, ref and subdirectory")
		}
		if p.Candidates == nil {
			return invalid("invalid_snapshot", "package candidates must be an array")
		}
		seen := map[string]bool{}
		for _, c := range p.Candidates {
			if (c.Path != "" && !labrastroSafeRepoPath(c.Path)) || seen[c.Path] {
				return invalid("invalid_snapshot", "invalid or duplicate candidate path")
			}
			seen[c.Path] = true
		}
		packages[p.ID], packageKeys[key] = p, true
	}
	folders := map[pgtype.UUID]labrastroMigrationFolder{}
	siblings, paths := map[string]bool{}, map[string]bool{}
	children := map[pgtype.UUID][]labrastroMigrationFolder{}
	for _, f := range s.Folders {
		key := labrastroMigrationSibling(f.ParentID, f.Name)
		if !labrastroMigrationUUID(f.ID) || folders[f.ID].ID.Valid || !labrastroFolderName(f.Name) || siblings[key] || f.PackageID.Valid != (f.PackagePath != nil) || (f.ParentID.Valid && !labrastroMigrationUUID(f.ParentID)) {
			return invalid("invalid_snapshot", "invalid or duplicate folder")
		}
		if f.PackageID.Valid {
			if !packages[f.PackageID].ID.Valid {
				return invalid("dangling_reference", "folder refers to a missing package")
			}
			key := labrastroMigrationPath(f.PackageID, *f.PackagePath)
			if paths[key] {
				return invalid("invalid_package_root", "duplicate managed folder path")
			}
			paths[key] = true
		}
		folders[f.ID], siblings[key] = f, true
		children[f.ParentID] = append(children[f.ParentID], f)
	}
	for _, f := range s.Folders {
		if f.ParentID.Valid && !folders[f.ParentID].ID.Valid {
			return invalid("dangling_reference", "folder refers to a missing parent")
		}
	}
	// Iterative traversal also bounds stack use for untrusted deep trees.
	ordered := append([]labrastroMigrationFolder{}, children[pgtype.UUID{}]...)
	for i := 0; i < len(ordered); i++ {
		ordered = append(ordered, children[ordered[i].ID]...)
	}
	if len(ordered) != len(folders) {
		return invalid("folder_cycle", "folder graph contains a cycle")
	}
	for _, f := range ordered {
		parent := folders[f.ParentID]
		if !f.PackageID.Valid {
			if parent.PackageID.Valid {
				return invalid("managed_folder", "custom folders cannot be inside a managed package")
			}
			continue
		}
		p := packages[f.PackageID]
		if *f.PackagePath == "" {
			if f.ID != p.RootFolderID || parent.PackageID.Valid {
				return invalid("invalid_package_root", "package root must be unique and outside managed folders")
			}
		} else {
			expected := path.Dir(*f.PackagePath)
			if expected == "." {
				expected = ""
			}
			if !labrastroSafeRepoPath(*f.PackagePath) || f.Name != path.Base(*f.PackagePath) || parent.PackageID != f.PackageID || parent.PackagePath == nil || *parent.PackagePath != expected {
				return invalid("invalid_package_root", "managed directory does not match its parent and package path")
			}
		}
	}
	for _, p := range s.Packages {
		root := folders[p.RootFolderID]
		if !root.ID.Valid || root.PackageID != p.ID || root.PackagePath == nil || *root.PackagePath != "" {
			return invalid("invalid_package_root", "package has no valid root folder")
		}
	}
	skills, sources := map[pgtype.UUID]bool{}, map[string]bool{}
	for _, p := range s.Placements {
		if !labrastroMigrationUUID(p.SkillID) || skills[p.SkillID] || p.Skill.Name == "" || len(p.Skill.Digest) != 64 {
			return invalid("invalid_snapshot", "invalid or duplicate placement skill")
		}
		if _, err := hex.DecodeString(p.Skill.Digest); err != nil {
			return invalid("invalid_snapshot", "invalid skill digest")
		}
		skills[p.SkillID] = true
		f := folders[p.FolderID]
		if !f.ID.Valid {
			return invalid("dangling_reference", "placement refers to a missing folder")
		}
		if p.PackageID.Valid != (p.SourcePath != nil) {
			return invalid("invalid_snapshot", "package and source_path must both be present or absent")
		}
		if p.PackageID.Valid {
			if !packages[p.PackageID].ID.Valid || f.PackageID != p.PackageID {
				return invalid("dangling_reference", "placement package does not own its folder")
			}
			key := labrastroMigrationPath(p.PackageID, *p.SourcePath)
			if (*p.SourcePath != "" && !labrastroSafeRepoPath(*p.SourcePath)) || sources[key] {
				return invalid("invalid_snapshot", "invalid or duplicate placement source_path")
			}
			sources[key] = true
		}
		if o := p.Skill.Origin; o != nil {
			if o.Path != nil && *o.Path != "" && !labrastroSafeRepoPath(*o.Path) {
				return invalid("invalid_snapshot", "invalid origin path")
			}
			if o.SourceURL != "" {
				u, err := url.Parse(o.SourceURL)
				if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
					return invalid("invalid_snapshot", "origin URL must not contain credentials, query or fragment")
				}
			}
		}
	}
	return ordered, nil
}

func labrastroMigrationLegacyPaths(s labrastroOrganizationSnapshot) map[string]map[string][]string {
	result := map[string]map[string][]string{}
	add := func(repo, name, p string) {
		repo = strings.ToLower(repo)
		if result[repo] == nil {
			result[repo] = map[string][]string{}
		}
		for _, slug := range []string{path.Base(p), name} {
			found := false
			for _, old := range result[repo][slug] {
				if old == p {
					found = true
				}
			}
			if !found {
				result[repo][slug] = append(result[repo][slug], p)
			}
		}
	}
	for _, p := range s.Packages {
		for _, c := range p.Candidates {
			add(p.OwnerRepo, c.Name, c.Path)
		}
	}
	for _, p := range s.Placements {
		if o := p.Skill.Origin; o != nil && o.Path != nil {
			add(o.Owner+"/"+o.Repo, p.Skill.Name, *o.Path)
		}
	}
	return result
}
func labrastroMigrationIdentity(o *labrastroMigrationOrigin, legacy map[string]map[string][]string) string {
	if o == nil {
		return ""
	}
	if o.Type == "github" || o.Type == "skills_sh" {
		if o.Owner == "" || o.Repo == "" {
			return ""
		}
		src := &labrastroSkillSource{spec: githubSpec{owner: o.Owner, repo: o.Repo}}
		config, _ := json.Marshal(map[string]any{"origin": o})
		repo := strings.ToLower(o.Owner + "/" + o.Repo)
		if p, ok := labrastroSourceIdentity(config, src, legacy[repo]); ok {
			return repo + "\x00" + p
		}
		return ""
	}
	// Other provenance kinds can only match identical, nonempty identities.
	if o.Type == "" {
		return ""
	}
	return "origin\x00" + labrastroJSONHash(o)
}
func labrastroMigrationFolderPath(id pgtype.UUID, folders map[pgtype.UUID]labrastroMigrationFolder) string {
	parts := []string{}
	seen := map[pgtype.UUID]bool{}
	for id.Valid && !seen[id] {
		seen[id] = true
		f, ok := folders[id]
		if !ok {
			break
		}
		parts = append(parts, f.Name)
		id = f.ParentID
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, " / ")
}
func labrastroPlanMigration(a labrastroSkillActor, source labrastroOrganizationSnapshot, ordered []labrastroMigrationFolder, target labrastroPackageSnapshot) labrastroMigrationPlan {
	plan := labrastroMigrationPlan{Folders: []labrastroMigrationFolderPlan{}, Packages: []labrastroMigrationPackagePlan{}, Placements: []labrastroMigrationPlacementPlan{}, Conflicts: []labrastroMigrationConflict{}, Summary: map[string]int{}}
	for _, key := range []string{"create", "reuse", "update", "place", "move", "unchanged", "skipped", "conflicts", "target_only_skills", "target_only_folders", "target_only_packages", "target_only_placements"} {
		plan.Summary[key] = 0
	}
	conflict := func(kind string, id pgtype.UUID, code, msg string) {
		plan.Conflicts = append(plan.Conflicts, labrastroMigrationConflict{kind, id, code, msg})
	}
	// Stable target UUIDs let apply recompute the exact signed plan without storing it.
	sourceHash := labrastroJSONHash([]any{source, target.Folders, target.Packages})
	newID := func(kind string, id pgtype.UUID) pgtype.UUID {
		return parseUUID(uuid.NewSHA1(uuid.UUID(a.ws.Bytes), []byte("skill-organization-v1/"+sourceHash+"/"+kind+"/"+uuidToString(id))).String())
	}
	packageMap := map[pgtype.UUID]pgtype.UUID{}
	targetPackages := map[pgtype.UUID]db.LabrastroSkillPackage{}
	byPackageKey := map[string][]db.LabrastroSkillPackage{}
	for _, p := range target.Packages {
		targetPackages[p.ID] = p
		key := labrastroMigrationPackageKey(p.OwnerRepo, p.Subdirectory)
		byPackageKey[key] = append(byPackageKey[key], p)
	}
	usedPackages := map[pgtype.UUID]bool{}
	for _, p := range source.Packages {
		item := labrastroMigrationPackagePlan{labrastroMigrationPackage: p, SourceID: p.ID, Action: "create"}
		item.ID = newID("package", p.ID)
		matches := byPackageKey[labrastroMigrationPackageKey(p.OwnerRepo, p.Subdirectory)]
		if len(matches) > 1 {
			conflict("package", p.ID, "package_ref_mismatch", "multiple target packages have the same normalized repository")
		}
		if len(matches) > 0 {
			existing := matches[0]
			item.ID = existing.ID
			usedPackages[item.ID] = true
			item.Action = "reuse"
			if existing.SourceUrl != p.SourceURL || existing.SourceRef != p.Ref {
				conflict("package", p.ID, "package_ref_mismatch", "target package has a different source URL or ref")
			} else {
				var candidates []labrastroSkillCandidateSummary
				if json.Unmarshal(existing.Candidates, &candidates) != nil || labrastroJSONHash(candidates) != labrastroJSONHash(p.Candidates) {
					item.Action = "update"
					if labrastroRequirePackageOwner(existing, a, target.Member) != nil {
						conflict("package", p.ID, "forbidden", "package candidate update requires importer or admin permission")
					}
				}
			}
		}
		packageMap[p.ID] = item.ID
		plan.Packages = append(plan.Packages, item)
	}
	folderMap := map[pgtype.UUID]pgtype.UUID{}
	folders := map[pgtype.UUID]labrastroMigrationFolder{}
	originalFolders := map[pgtype.UUID]labrastroMigrationFolder{}
	bySibling := map[string]pgtype.UUID{}
	byPackagePath := map[string]pgtype.UUID{}
	for _, f := range target.Folders {
		item := labrastroMigrationFolder{f.ID, f.ParentID, f.Name, f.PackageID, labrastroMigrationString(f.PackagePath)}
		folders[f.ID], originalFolders[f.ID] = item, item
		bySibling[labrastroMigrationSibling(f.ParentID, f.Name)] = f.ID
		if f.PackageID.Valid {
			byPackagePath[labrastroMigrationPath(f.PackageID, f.PackagePath.String)] = f.ID
		}
	}
	usedFolders := map[pgtype.UUID]bool{}
	for _, f := range ordered {
		item := labrastroMigrationFolderPlan{labrastroMigrationFolder: f, SourceID: f.ID, Action: "create"}
		item.ID = newID("folder", f.ID)
		item.ParentID = folderMap[f.ParentID]
		item.PackageID = packageMap[f.PackageID]
		sibling := labrastroMigrationSibling(item.ParentID, item.Name)
		occupied := bySibling[sibling]
		if !f.PackageID.Valid {
			if occupied.Valid && !folders[occupied].PackageID.Valid {
				item.ID = occupied
				item.Action = "reuse"
			}
		} else {
			existingPackage := targetPackages[item.PackageID]
			existingID := byPackagePath[labrastroMigrationPath(item.PackageID, *f.PackagePath)]
			if *f.PackagePath == "" && existingPackage.ID.Valid {
				existingID = existingPackage.RootFolderID
			}
			if existingID.Valid {
				item.ID = existingID
				item.Action = "reuse"
				old, found := folders[existingID]
				if !found || old.PackageID != item.PackageID || old.PackagePath == nil || *old.PackagePath != *f.PackagePath {
					conflict("folder", f.ID, "invalid_package_root", "target package has an invalid managed folder")
				}
				if old.ParentID != item.ParentID || old.Name != item.Name {
					item.Action = "update"
					if labrastroRequirePackageOwner(existingPackage, a, target.Member) != nil {
						conflict("folder", f.ID, "forbidden", "managed folder update requires importer or admin permission")
					}
				}
			}
		}
		if occupied.Valid && occupied != item.ID {
			conflict("folder", f.ID, "folder_name_conflict", "target sibling name is already occupied")
		}
		seen := map[pgtype.UUID]bool{}
		for parent := item.ParentID; parent.Valid; parent = folders[parent].ParentID {
			if parent == item.ID || seen[parent] {
				conflict("folder", f.ID, "folder_cycle", "mapped folder move would create a cycle")
				break
			}
			seen[parent] = true
		}
		if old, exists := folders[item.ID]; exists {
			usedFolders[item.ID] = true
			delete(bySibling, labrastroMigrationSibling(old.ParentID, old.Name))
		}
		folders[item.ID] = item.labrastroMigrationFolder
		bySibling[sibling] = item.ID
		folderMap[f.ID] = item.ID
		plan.Folders = append(plan.Folders, item)
	}
	for i := range plan.Packages {
		plan.Packages[i].RootFolderID = folderMap[plan.Packages[i].RootFolderID]
	}
	index := labrastroIndexTargets(target)
	legacy := labrastroMigrationLegacyPaths(source)
	byName := map[string][]db.LabrastroListSkillStatesRow{}
	byIdentity := map[string][]db.LabrastroListSkillStatesRow{}
	identities := map[pgtype.UUID]string{}
	origins := map[pgtype.UUID]*labrastroMigrationOrigin{}
	for _, st := range target.States {
		byName[st.Name] = append(byName[st.Name], st)
		o := labrastroMigrationOriginFromConfig(st.Config)
		origins[st.ID] = o
		identity := labrastroMigrationIdentity(o, legacy)
		identities[st.ID] = identity
		if identity != "" {
			byIdentity[identity] = append(byIdentity[identity], st)
		}
	}
	bySource := map[string]db.LabrastroListSkillStatesRow{}
	for _, p := range target.Places {
		if p.PackageID.Valid {
			bySource[labrastroMigrationPath(p.PackageID, p.SourcePath.String)] = index.states[p.SkillID]
		}
	}
	usedSkills := map[pgtype.UUID]bool{}
	for _, p := range source.Placements {
		item := labrastroMigrationPlacementPlan{labrastroMigrationPlacement: p, SourceSkillID: p.SkillID, Action: "place"}
		item.SkillID = pgtype.UUID{}
		item.FolderID = folderMap[p.FolderID]
		item.PackageID = packageMap[p.PackageID]
		item.ToPath = labrastroMigrationFolderPath(item.FolderID, folders)
		var matches []db.LabrastroListSkillStatesRow
		sourceIdentity := labrastroMigrationIdentity(p.Skill.Origin, legacy)
		if p.PackageID.Valid {
			if st, ok := bySource[labrastroMigrationPath(item.PackageID, *p.SourcePath)]; ok {
				matches = []db.LabrastroListSkillStatesRow{st}
			}
		}
		if len(matches) == 0 && sourceIdentity != "" {
			matches = byIdentity[sourceIdentity]
		}
		if len(matches) == 0 {
			matches = byName[p.Skill.Name]
		}
		code := ""
		switch {
		case len(matches) > 1:
			code = "ambiguous_target_skill"
		case len(matches) == 0:
			item.Action = "skipped"
			item.Code = "target_skill_missing"
		default:
			st := matches[0]
			item.SkillID = st.ID
			sameOrigin := sourceIdentity != "" && sourceIdentity == identities[st.ID]
			sameLocal := origins[st.ID] == nil && st.Name == p.Skill.Name && labrastroStateDigest(st) == p.Skill.Digest
			if !(sameOrigin || sameLocal) || (p.Skill.Origin == nil && origins[st.ID] != nil) {
				code = "source_mismatch"
			} else if usedSkills[st.ID] {
				code = "ambiguous_target_skill"
			}
			usedSkills[st.ID] = true
			current := index.places[st.ID]
			item.FromFolderID = current.FolderID
			item.FromPath = labrastroMigrationFolderPath(current.FolderID, originalFolders)
			if code == "" {
				if current.FolderID == item.FolderID && current.PackageID == item.PackageID && current.SourcePath == labrastroMigrationText(item.SourcePath) {
					item.Action = "unchanged"
				} else if !labrastroCanManage(st.CreatedBy, a, target.Member) {
					code = "forbidden"
				} else if current.PackageID.Valid && (current.PackageID != item.PackageID || current.SourcePath != labrastroMigrationText(item.SourcePath)) {
					code = "already_packaged"
				} else if current.FolderID.Valid {
					item.Action = "move"
				}
			}
		}
		if code != "" {
			item.Action = "conflict"
			item.Code = code
			conflict("placement", p.SkillID, code, "target skill cannot be safely mapped or moved")
		}
		plan.Placements = append(plan.Placements, item)
	}
	count := func(action string) {
		if action != "conflict" {
			plan.Summary[action]++
		}
	}
	for _, f := range plan.Folders {
		count(f.Action)
	}
	for _, p := range plan.Packages {
		count(p.Action)
	}
	for _, p := range plan.Placements {
		count(p.Action)
	}
	plan.Summary["conflicts"] = len(plan.Conflicts)
	plan.Summary["target_only_skills"] = len(target.States) - len(usedSkills)
	plan.Summary["target_only_folders"] = len(target.Folders) - len(usedFolders)
	plan.Summary["target_only_packages"] = len(target.Packages) - len(usedPackages)
	for _, p := range target.Places {
		if !usedSkills[p.SkillID] {
			plan.Summary["target_only_placements"]++
		}
	}
	plan.CanApply = len(plan.Conflicts) == 0
	return plan
}
func labrastroMigrationFingerprint(a labrastroSkillActor, source labrastroOrganizationSnapshot, target labrastroPackageSnapshot, plan labrastroMigrationPlan) string {
	plan.PreviewID = ""
	return labrastroJSONHash([]any{"organization-migration-v1", a.ws, a.user, target.Member.ID, target.Member.Role, source, target.States, target.Places, target.Folders, target.Packages, plan})
}
func (h *Handler) LabrastroPreviewSkillMigration(w http.ResponseWriter, r *http.Request) {
	h.labrastroSkillMigration(w, r, false)
}
func (h *Handler) LabrastroApplySkillMigration(w http.ResponseWriter, r *http.Request) {
	h.labrastroSkillMigration(w, r, true)
}
func (h *Handler) labrastroSkillMigration(w http.ResponseWriter, r *http.Request, apply bool) {
	a, ok := h.labrastroSkillActor(w, r)
	if !ok {
		return
	}
	var snapshot labrastroOrganizationSnapshot
	var token string
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	d.DisallowUnknownFields()
	var err error
	if apply {
		var req struct {
			Snapshot  labrastroOrganizationSnapshot `json:"snapshot"`
			PreviewID string                        `json:"preview_id"`
		}
		err = d.Decode(&req)
		snapshot, token = req.Snapshot, req.PreviewID
	} else {
		var req struct {
			Snapshot labrastroOrganizationSnapshot `json:"snapshot"`
		}
		err = d.Decode(&req)
		snapshot = req.Snapshot
	}
	if err != nil || d.Decode(new(any)) != io.EOF {
		labrastroWriteSkillError(w, labrastroSkillError(400, "invalid_snapshot", "invalid request body (maximum 8 MiB; unknown fields are rejected)"))
		return
	}
	ordered, err := labrastroValidateOrganization(snapshot)
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), importFetchTimeout)
	defer cancel()
	var target labrastroPackageSnapshot
	var tx pgx.Tx
	var q *db.Queries
	if apply {
		tx, q, _, err = h.labrastroSkillTx(ctx, a, true)
		if err == nil {
			defer tx.Rollback(context.Background())
			target, err = labrastroReadPackageSnapshot(ctx, q, a)
		}
	} else {
		target, err = h.labrastroReadOrganization(ctx, a)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	plan := labrastroPlanMigration(a, snapshot, ordered, target)
	fingerprint := labrastroMigrationFingerprint(a, snapshot, target, plan)
	if !apply {
		plan.PreviewID = labrastroSignPreview(fingerprint, time.Now().Add(15*time.Minute).Unix())
		writeJSON(w, 200, plan)
		return
	}
	if !labrastroValidatePreview(token, fingerprint) {
		labrastroWriteSkillError(w, labrastroStalePreview())
		return
	}
	if !plan.CanApply {
		writeJSON(w, 409, map[string]any{"code": "migration_conflict", "error": "organization migration has blocking conflicts", "plan": plan})
		return
	}
	changed := plan.Summary["create"]+plan.Summary["update"]+plan.Summary["move"]+plan.Summary["place"] > 0
	if changed {
		err = labrastroWriteMigration(ctx, q, a, target.Member, plan)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		labrastroWriteSkillError(w, err)
		return
	}
	plan.Changed = changed
	if changed {
		actorType, actorID := h.resolveActor(r, uuidToString(a.user), uuidToString(a.ws))
		h.publish(protocol.EventSkillUpdated, uuidToString(a.ws), actorType, actorID, map[string]any{"organization_migrated": true})
		slog.Info("skill organization migrated", append(logger.RequestAttrs(r), "workspace_id", uuidToString(a.ws), "changes", plan.Summary)...)
	}
	writeJSON(w, 200, plan)
}
func labrastroWriteMigration(ctx context.Context, q *db.Queries, a labrastroSkillActor, m db.Member, plan labrastroMigrationPlan) error {
	// Acquire skill locks in UUID order before any mutation, matching other writers.
	places := append([]labrastroMigrationPlacementPlan{}, plan.Placements...)
	sort.Slice(places, func(i, j int) bool { return uuidToString(places[i].SkillID) < uuidToString(places[j].SkillID) })
	for _, p := range places {
		if p.Action != "place" && p.Action != "move" {
			continue
		}
		st, err := q.LabrastroLockSkill(ctx, db.LabrastroLockSkillParams{WorkspaceID: a.ws, ID: p.SkillID})
		if err != nil {
			return err
		}
		if !labrastroCanManage(st.CreatedBy, a, m) {
			return labrastroStalePreview()
		}
	}
	if err := q.LabrastroCleanSkillPlacements(ctx, a.ws); err != nil {
		return err
	}
	for _, f := range plan.Folders {
		var err error
		switch f.Action {
		case "create":
			_, err = q.LabrastroCreateSkillFolder(ctx, db.LabrastroCreateSkillFolderParams{ID: f.ID, WorkspaceID: a.ws, ParentID: f.ParentID, Name: f.Name, PackageID: f.PackageID, PackagePath: labrastroMigrationText(f.PackagePath)})
		case "update":
			_, err = q.LabrastroUpdateSkillFolder(ctx, db.LabrastroUpdateSkillFolderParams{WorkspaceID: a.ws, ID: f.ID, ParentID: f.ParentID, Name: f.Name})
		}
		if err != nil {
			return err
		}
	}
	for _, p := range plan.Packages {
		candidates, err := json.Marshal(p.Candidates)
		if err != nil {
			return err
		}
		switch p.Action {
		case "create":
			_, err = q.LabrastroCreateSkillPackage(ctx, db.LabrastroCreateSkillPackageParams{ID: p.ID, WorkspaceID: a.ws, OwnerRepo: strings.ToLower(p.OwnerRepo), Subdirectory: p.Subdirectory, SourceUrl: p.SourceURL, SourceRef: p.Ref, RootFolderID: p.RootFolderID, CreatedBy: a.user, Candidates: candidates})
		case "update":
			_, err = q.LabrastroApplySkillPackage(ctx, db.LabrastroApplySkillPackageParams{ID: p.ID, WorkspaceID: a.ws, SourceUrl: p.SourceURL, SourceRef: p.Ref, Candidates: candidates})
		}
		if err != nil {
			return err
		}
	}
	for _, p := range places {
		if p.Action != "place" && p.Action != "move" {
			continue
		}
		if err := q.LabrastroPlaceSkill(ctx, db.LabrastroPlaceSkillParams{WorkspaceID: a.ws, SkillID: p.SkillID, FolderID: p.FolderID, PackageID: p.PackageID, SourcePath: labrastroMigrationText(p.SourcePath)}); err != nil {
			return err
		}
	}
	// No pruning: source empty directories and target-only directories are preserved.
	return nil
}
