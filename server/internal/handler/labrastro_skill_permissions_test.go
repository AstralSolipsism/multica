package handler

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestLabrastroPackageNonImporterCannotPreviewOrApplyAnotherRef(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	member := fx.User(t, "member", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, member, "member")
	for _, endpoint := range []http.HandlerFunc{testHandler.LabrastroPreviewPackage, testHandler.LabrastroApplyPackage} {
		labrastroCall(t, fx, member, endpoint, "POST", map[string]any{"url": source.url() + "/tree/v2", "preview_id": preview.PreviewID}).Want(403)
	}
	var ref string
	fx.QueryRow(t, "SELECT source_ref FROM labrastro_skill_package WHERE id=$1", report.Package.ID).Scan(&ref)
	if ref != "main" {
		t.Fatalf("unauthorized operation changed ref to %q", ref)
	}
}

func TestLabrastroPackageDefaultSkipCannotOverwriteAnotherCreatorsName(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	creator := fx.User(t, "creator", uuid.NewString()+"@example.com")
	sid := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "keep", "created_by": creator})
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "---\nname: alpha\n---\nreplace"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if report.Failed || len(report.Results) != 1 || report.Results[0].Status != "skipped" || report.Results[0].Code != "name_conflict" {
		t.Fatalf("default name conflict must skip, even for admins: %+v", report)
	}
	var content string
	fx.QueryRow(t, "SELECT content FROM skill WHERE id=$1", sid).Scan(&content)
	if content != "keep" || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1", sid) != 0 {
		t.Fatal("default skip modified the other creator's skill")
	}
}

func TestLabrastroPackageRescanCannotSwitchRepository(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	source.Repo = "another-repository"
	var failure struct{ Code string }
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{"url": source.url()}, "packageId", report.Package.ID).Want(409).JSON(&failure)
	if failure.Code != "source_changed" || fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE workspace_id=$1 AND owner_repo='fixture/skills'", fx.WorkspaceID) != 1 {
		t.Fatalf("rescan changed repository identity: %+v", failure)
	}
}

func TestLabrastroPackageDefaultSelectionSkipsForbiddenAdoption(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	creator := fx.User(t, "creator", uuid.NewString()+"@example.com")
	sid := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "keep", "created_by": creator, "config": testutil.Raw(`'{"origin":{"type":"github","owner":"fixture","repo":"skills","path":"alpha"}}'::jsonb`)})
	fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "---\nname: alpha\n---\nreplace"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if report.Failed || len(report.Results) != 1 || report.Results[0].Status != "skipped" || report.Results[0].Code != "forbidden" {
		t.Fatalf("default selection should skip an unauthorized adoption: %+v", report)
	}
	var content string
	fx.QueryRow(t, "SELECT content FROM skill WHERE id=$1", sid).Scan(&content)
	if content != "keep" || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1", sid) != 0 {
		t.Fatal("unauthorized adoption changed contents or placement")
	}
	preview = labrastroPreview(t, fx, testUserID, source.url())
	explicit := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"all": true})
	if !explicit.Failed || explicit.Results[0].Status != "failed" || explicit.Results[0].Code != "forbidden" {
		t.Fatalf("explicit unauthorized adoption must report failure: %+v", explicit)
	}
}

func TestLabrastroPackageRemovalRejectsInvalidAndStalePreview(t *testing.T) {
	for _, op := range []struct {
		name, method string
		handler      http.HandlerFunc
	}{{"delete", "DELETE", testHandler.LabrastroDeletePackage}, {"dissolve", "POST", testHandler.LabrastroDissolvePackage}} {
		t.Run(op.name, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
			var impact struct {
				PreviewID string `json:"preview_id"`
			}
			labrastroCall(t, fx, testUserID, testHandler.LabrastroPackageDeletePreview, "GET", nil, "packageId", report.Package.ID).Want(200).JSON(&impact)
			fx.Exec(t, "UPDATE skill SET content='changed after preview' WHERE id=$1", report.Results[0].SkillID)
			for _, token := range []string{"forged", impact.PreviewID} {
				labrastroCall(t, fx, testUserID, op.handler, op.method, map[string]string{"preview_id": token}, "packageId", report.Package.ID).Want(409)
			}
			for _, table := range []string{"skill", "labrastro_skill_package", "labrastro_skill_folder", "labrastro_skill_placement"} {
				if fx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", fx.WorkspaceID) != 1 {
					t.Fatalf("rejected %s changed %s", op.name, table)
				}
			}
		})
	}
}

func TestLabrastroNonCreatorCannotMoveOrDetachSkill(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	member := fx.User(t, "member", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, member, "member")
	managed := report.Results[0].SkillID
	labrastroCall(t, fx, member, testHandler.LabrastroDetachSkill, "POST", nil, "skillId", managed).Want(403)
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1 AND package_id IS NOT NULL", managed) != 1 {
		t.Fatal("non-creator detached a managed skill")
	}
	ordinary := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "ordinary", "content": "keep", "created_by": testUserID})
	var folder db.LabrastroSkillFolder
	labrastroCall(t, fx, testUserID, testHandler.LabrastroCreateFolder, "POST", map[string]string{"name": "destination"}).Want(201).JSON(&folder)
	labrastroCall(t, fx, member, testHandler.LabrastroMoveSkill, "PUT", map[string]string{"folder_id": uuidToString(folder.ID)}, "skillId", ordinary).Want(403)
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1", ordinary) != 0 {
		t.Fatal("non-creator moved an ordinary skill")
	}
}

func TestLabrastroNonImporterCannotRenameOrMovePackageRoot(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	member := fx.User(t, "member", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, member, "member")
	var folder db.LabrastroSkillFolder
	labrastroCall(t, fx, member, testHandler.LabrastroCreateFolder, "POST", map[string]string{"name": "destination"}).Want(201).JSON(&folder)
	for _, change := range []map[string]string{{"name": "stolen"}, {"parent_id": uuidToString(folder.ID)}} {
		labrastroCall(t, fx, member, testHandler.LabrastroUpdateFolder, "PATCH", change, "folderId", report.Package.RootFolderID).Want(403)
	}
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE id=$1 AND name='fixture/skills' AND parent_id IS NULL", report.Package.RootFolderID) != 1 {
		t.Fatal("non-importer changed the package root")
	}
}

func TestLabrastroPackageCandidateLimitRejectsOversizedSource(t *testing.T) {
	files := map[string]string{}
	for i := 0; i <= labrastroMaxCandidates; i++ {
		files[fmt.Sprintf("skill-%04d/SKILL.md", i)] = "skill"
	}
	source := labrastroTestFixture(files)
	src, err := newLabrastroSkillSource(t.Context(), source.client(), source.url(), t.Name())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := src.candidates(t.Context()); !isCapError(err) {
		t.Fatalf("oversized source must fail with a non-retryable cap error: %v", err)
	}
	for _, request := range source.paths {
		if strings.Contains(request, "/SKILL.md") {
			t.Fatalf("limit checked after downloading candidates: %s", request)
		}
	}
}

func TestLabrastroPackageReadsAreScopedToSelectedWorkspace(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	other := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	var own LabrastroSkillPackageResponse
	labrastroCall(t, fx, testUserID, testHandler.LabrastroGetPackage, "GET", nil, "packageId", report.Package.ID).Want(200).JSON(&own)
	if own.ID != report.Package.ID || own.OwnerRepo != "fixture/skills" {
		t.Fatalf("wrong package: %+v", own)
	}
	labrastroCall(t, other, testUserID, testHandler.LabrastroGetPackage, "GET", nil, "packageId", report.Package.ID).Want(404)
	for _, endpoint := range []http.HandlerFunc{testHandler.LabrastroSkillTree, testHandler.LabrastroListPackages} {
		var own, foreign struct {
			Packages   []LabrastroSkillPackageResponse `json:"packages"`
			Folders    []db.LabrastroSkillFolder       `json:"folders"`
			Placements []db.LabrastroSkillPlacement    `json:"placements"`
		}
		labrastroCall(t, fx, testUserID, endpoint, "GET", nil).Want(200).JSON(&own)
		labrastroCall(t, other, testUserID, endpoint, "GET", nil).Want(200).JSON(&foreign)
		if len(own.Packages) != 1 || own.Packages[0].ID != report.Package.ID || len(foreign.Packages)+len(foreign.Folders)+len(foreign.Placements) != 0 {
			t.Fatalf("workspace read leaked or lost package: own=%+v foreign=%+v", own, foreign)
		}
	}
	var tree struct {
		Folders    []db.LabrastroSkillFolder
		Placements []db.LabrastroSkillPlacement
	}
	labrastroCall(t, fx, testUserID, testHandler.LabrastroSkillTree, "GET", nil).Want(200).JSON(&tree)
	if len(tree.Folders) != 1 || uuidToString(tree.Folders[0].ID) != report.Package.RootFolderID || len(tree.Placements) != 1 || uuidToString(tree.Placements[0].SkillID) != report.Results[0].SkillID {
		t.Fatalf("tree missing imported folder/placement: %+v", tree)
	}
}
