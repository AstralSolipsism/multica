package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func init() {
	for _, table := range []string{"labrastro_skill_folder", "labrastro_skill_package", "labrastro_skill_placement"} {
		workspaceDeletionManifest[table] = workspaceDelete
	}
}

func labrastroPackageDBFixture(t *testing.T) *testutil.Fixture {
	t.Helper()
	ws := dbfx.Workspace(t, "package tests", "pkg-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	fx := testutil.New(testPool, ws, testUserID)
	t.Cleanup(func() {
		ctx := context.Background()
		for _, table := range []string{"labrastro_skill_placement", "labrastro_skill_package", "labrastro_skill_folder"} {
			testPool.Exec(ctx, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
		}
		testPool.Exec(ctx, "DELETE FROM skill_file WHERE skill_id IN (SELECT id FROM skill WHERE workspace_id=$1)", ws)
		testPool.Exec(ctx, "DELETE FROM agent_skill WHERE skill_id IN (SELECT id FROM skill WHERE workspace_id=$1)", ws)
		testPool.Exec(ctx, "DELETE FROM skill_to_label WHERE skill_id IN (SELECT id FROM skill WHERE workspace_id=$1)", ws)
		testPool.Exec(ctx, "DELETE FROM skill WHERE workspace_id=$1", ws)
	})
	return fx
}
func labrastroCall(t *testing.T, fx *testutil.Fixture, uid string, h http.HandlerFunc, method string, body any, params ...string) *testutil.Response {
	t.Helper()
	req := newRequestAsUser(uid, method, "/api/skill-packages", body)
	req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	req = testutil.WithURLParams(req, params...)
	return testutil.Call(t, h, req)
}
func labrastroPreview(t *testing.T, fx *testutil.Fixture, uid, url string) LabrastroPackagePreview {
	t.Helper()
	var out LabrastroPackagePreview
	labrastroCall(t, fx, uid, testHandler.LabrastroPreviewPackage, "POST", map[string]any{"url": url}).Want(200).JSON(&out)
	return out
}
func labrastroApply(t *testing.T, fx *testutil.Fixture, uid, url, token string, extra map[string]any) LabrastroPackageApplyResult {
	t.Helper()
	body := map[string]any{"url": url, "preview_id": token}
	for k, v := range extra {
		body[k] = v
	}
	var out LabrastroPackageApplyResult
	labrastroCall(t, fx, uid, testHandler.LabrastroApplyPackage, "POST", body).Want(200).JSON(&out)
	return out
}

func TestLabrastroPackagePreviewApplyRescan(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\n[a](../../references/a.md)", "references/a.md": "shared", "skills/beta/SKILL.md": "---\nname: beta\n---\nbeta", ".claude-plugin/plugin.json": `{"skills":["./skills/alpha"]}`})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	if len(preview.Candidates) != 2 || !preview.Candidates[0].DefaultSelected || preview.Candidates[1].DefaultSelected {
		t.Fatalf("manifest defaults: %+v", preview.Candidates)
	}
	for _, table := range []string{"labrastro_skill_package", "labrastro_skill_folder", "labrastro_skill_placement", "skill"} {
		if n := fx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", fx.WorkspaceID); n != 0 {
			t.Fatalf("preview wrote %d rows to %s", n, table)
		}
	}
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if report.Failed || report.Package == nil || report.Results[0].Status != "created" || report.Results[1].Status != "skipped" {
		t.Fatalf("apply: %+v", report)
	}
	skillID := report.Results[0].SkillID
	preview = labrastroPreview(t, fx, testUserID, source.url())
	if preview.Candidates[0].State != "unchanged" || preview.Candidates[1].DefaultSelected {
		t.Fatalf("rescan defaults: %+v", preview.Candidates)
	}
	before := fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE workspace_id=$1", fx.WorkspaceID)
	labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE workspace_id=$1", fx.WorkspaceID) != before {
		t.Fatal("repeated import duplicated package")
	}
	source.Files["skills/alpha/SKILL.md"] = "---\nname: alpha-renamed\n---\nnew"
	source.Files["skills/new/SKILL.md"] = "---\nname: newly-discovered\n---\nnew"
	source.rebuild()
	labrastroCall(t, fx, testUserID, testHandler.LabrastroApplyPackage, "POST", map[string]any{"url": source.url(), "preview_id": preview.PreviewID}).Want(409)
	var scan LabrastroPackagePreview
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{}, "packageId", report.Package.ID).Want(200).JSON(&scan)
	if scan.Candidates[0].State != "changed" || !scan.Candidates[0].DefaultSelected || scan.Candidates[2].DefaultSelected {
		t.Fatalf("changed/default/new: %+v", scan.Candidates)
	}
	var updated LabrastroPackageApplyResult
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{"preview_id": scan.PreviewID, "apply": true}, "packageId", report.Package.ID).Want(200).JSON(&updated)
	if updated.Failed || updated.Results[0].SkillID != skillID || updated.Results[0].Status != "updated" {
		t.Fatalf("rename must preserve ID: %+v", updated)
	}
	if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 1 {
		t.Fatal("rescan imported an unselected new skill")
	}
	delete(source.Files, "skills/alpha/SKILL.md")
	source.rebuild()
	preview = labrastroPreview(t, fx, testUserID, source.url())
	retained := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if retained.Results[0].Status != "retained" || fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1", skillID) != 1 {
		t.Fatalf("deleted source was not retained: %+v", retained)
	}
}

func TestLabrastroPackageAdoptionAndDeletePermissions(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	creator := fx.User(t, "creator", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, creator, "member")
	sid := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "original", "config": testutil.Raw(`'{"custom":true,"origin":{"type":"skills_sh","owner":"fixture","repo":"skills","skill":"alpha","source_url":"https://skills.sh/fixture/skills/alpha"}}'::jsonb`), "created_by": creator})
	runtimeID := fx.Runtime(t, "package runtime")
	agent := fx.Agent(t, "bound agent", runtimeID)
	fx.InsertNoID(t, "agent_skill", testutil.Cols{"agent_id": agent, "skill_id": sid}, "agent_id=$1 AND skill_id=$2", agent, sid)
	label := fx.Insert(t, "issue_label", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "package label", "color": "red"})
	fx.InsertNoID(t, "skill_to_label", testutil.Cols{"skill_id": sid, "label_id": label}, "skill_id=$1 AND label_id=$2", sid, label)
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\nnew"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	if preview.Candidates[0].State != "adoptable" {
		t.Fatalf("legacy identity was not resolved: %+v", preview.Candidates)
	}
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if report.Failed || report.Results[0].Status != "adopted" || report.Results[0].SkillID != sid {
		t.Fatalf("adoption: %+v", report)
	}
	var owner string
	var custom bool
	fx.QueryRow(t, "SELECT created_by::text,(config->>'custom')::boolean FROM skill WHERE id=$1", sid).Scan(&owner, &custom)
	if owner != creator || !custom || fx.Count(t, "SELECT count(*) FROM agent_skill WHERE skill_id=$1", sid) != 1 || fx.Count(t, "SELECT count(*) FROM skill_to_label WHERE skill_id=$1", sid) != 1 {
		t.Fatal("adoption changed creator, config, labels or bindings")
	}
	fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
	var impact struct {
		PreviewID string `json:"preview_id"`
		CanDelete bool   `json:"can_delete"`
		Affected  []any  `json:"affected_agents"`
	}
	labrastroCall(t, fx, testUserID, testHandler.LabrastroPackageDeletePreview, "GET", nil, "packageId", report.Package.ID).Want(200).JSON(&impact)
	if impact.CanDelete || len(impact.Affected) != 1 {
		t.Fatalf("delete impact/permission: %+v", impact)
	}
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDeletePackage, "DELETE", map[string]string{"preview_id": impact.PreviewID}, "packageId", report.Package.ID).Want(403)
	if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1", sid) != 1 {
		t.Fatal("package ownership bypassed skill permission")
	}
	fx.Exec(t, "UPDATE member SET role='owner' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroPackageDeletePreview, "GET", nil, "packageId", report.Package.ID).Want(200).JSON(&impact)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDissolvePackage, "POST", map[string]string{"preview_id": impact.PreviewID}, "packageId", report.Package.ID).Want(200)
	if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1", sid) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE workspace_id=$1 AND package_id IS NULL", fx.WorkspaceID) != 1 {
		t.Fatal("dissolve did not preserve ordinary skills and folders")
	}
}

func TestLabrastroPackagePermissionChangeAndAtomicPartialFailure(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\nreplacement", "skills/beta/SKILL.md": "---\nname: beta\n---\nsuccess"})
	source.install(t)
	sid := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "original", "config": testutil.Raw(`'{"origin":{"type":"github","owner":"fixture","repo":"skills","path":"skills/alpha","source_url":"https://github.com/fixture/skills/tree/main/skills/alpha"}}'::jsonb`), "created_by": testUserID})
	fx.Insert(t, "skill_file", testutil.Cols{"skill_id": sid, "path": "original.md", "content": "keep"})
	preview := labrastroPreview(t, fx, testUserID, source.url())
	fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroApplyPackage, "POST", map[string]any{"url": source.url(), "preview_id": preview.PreviewID}).Want(409)
	constraint := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	fx.Exec(t, fmt.Sprintf("ALTER TABLE labrastro_skill_placement ADD CONSTRAINT %s CHECK (workspace_id <> '%s'::uuid OR source_path <> 'skills/alpha') NOT VALID", constraint, fx.WorkspaceID))
	fx.Cleanup(t, "ALTER TABLE labrastro_skill_placement DROP CONSTRAINT "+constraint)
	preview = labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if !report.Failed || report.Results[0].Status != "failed" || report.Results[1].Status != "created" {
		t.Fatalf("partial report: %+v", report)
	}
	var content string
	fx.QueryRow(t, "SELECT content FROM skill WHERE id=$1", sid).Scan(&content)
	if content != "original" || fx.Count(t, "SELECT count(*) FROM skill_file WHERE skill_id=$1 AND path='original.md'", sid) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1", sid) != 0 {
		t.Fatal("failed placement left half an overwrite")
	}
	if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1 AND name='beta'", fx.WorkspaceID) != 1 {
		t.Fatal("successful item was rolled back with failed item")
	}
}

func TestLabrastroFoldersIsolationAndConcurrentCycle(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	var a, b db.LabrastroSkillFolder
	labrastroCall(t, fx, testUserID, testHandler.LabrastroCreateFolder, "POST", map[string]string{"name": "a"}).Want(201).JSON(&a)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroCreateFolder, "POST", map[string]string{"name": "b"}).Want(201).JSON(&b)
	other := labrastroPackageDBFixture(t)
	labrastroCall(t, other, testUserID, testHandler.LabrastroUpdateFolder, "PATCH", map[string]string{"name": "stolen"}, "folderId", uuidToString(a.ID)).Want(404)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, pair := range [][2]string{{uuidToString(a.ID), uuidToString(b.ID)}, {uuidToString(b.ID), uuidToString(a.ID)}} {
		wg.Add(1)
		go func(pair [2]string) {
			defer wg.Done()
			req := newRequestAsUser(testUserID, "PATCH", "/api/skill-folders", map[string]string{"parent_id": pair[1]})
			req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
			req = withURLParams(req, "folderId", pair[0])
			w := httptest.NewRecorder()
			testHandler.LabrastroUpdateFolder(w, req)
			codes <- w.Code
		}(pair)
	}
	wg.Wait()
	close(codes)
	success, conflict := 0, 0
	for c := range codes {
		if c == 200 {
			success++
		} else if c == 409 {
			conflict++
		} else {
			t.Fatalf("unexpected move status: %d", c)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent moves allowed a cycle: success=%d conflict=%d", success, conflict)
	}
	var root, child string
	fx.QueryRow(t, "SELECT id::text FROM labrastro_skill_folder WHERE workspace_id=$1 AND parent_id IS NULL", fx.WorkspaceID).Scan(&root)
	fx.QueryRow(t, "SELECT id::text FROM labrastro_skill_folder WHERE workspace_id=$1 AND parent_id IS NOT NULL", fx.WorkspaceID).Scan(&child)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDeleteFolder, "DELETE", nil, "folderId", root).Want(200)
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE id=$1 AND parent_id IS NULL", child) != 1 {
		t.Fatal("folder deletion did not promote direct contents")
	}
}

func TestLabrastroPackageConflictsAndManagedTree(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	creator := fx.User(t, "other", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, creator, "member")
	sid := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "other source", "created_by": creator})
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\nnew"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"on_conflict": "overwrite"})
	if !report.Failed || report.Results[0].Code != "forbidden" {
		t.Fatalf("admin bypassed creator-only overwrite: %+v", report)
	}
	preview = labrastroPreview(t, fx, testUserID, source.url())
	report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"on_conflict": "rename", "all": true})
	if report.Failed || report.Results[0].Status != "created" || report.Results[0].SkillID == sid {
		t.Fatalf("rename failed: %+v", report)
	}
	labrastroCall(t, fx, testUserID, testHandler.LabrastroCreateFolder, "POST", map[string]string{"name": "custom", "parent_id": report.Package.RootFolderID}).Want(409)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroMoveSkill, "PUT", map[string]string{"folder_id": ""}, "skillId", report.Results[0].SkillID).Want(409)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDetachSkill, "POST", nil, "skillId", report.Results[0].SkillID).Want(200)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroMoveSkill, "PUT", map[string]string{"folder_id": ""}, "skillId", report.Results[0].SkillID).Want(200)
}

func TestLabrastroPackageSelectionRefAndTreeChange(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/group/alpha/SKILL.md": "---\nname: alpha\n---\nalpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	empty := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"skills": []string{}})
	if empty.Package != nil || fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
		t.Fatal("explicit empty selection created a package")
	}
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if report.Failed || report.Package.SourceURL != source.url()+"/tree/main" {
		t.Fatalf("resolved ref was not retained: %+v", report)
	}
	// A new category changes the common prefix. The existing item's content
	// stays identical but its placement must participate in the normal apply.
	source.Files["skills/other/beta/SKILL.md"] = "---\nname: beta\n---\nbeta"
	source.rebuild()
	preview = labrastroPreview(t, fx, testUserID, source.url())
	if preview.Candidates[0].State != "changed" || !preview.Candidates[0].DefaultSelected || preview.Candidates[1].DefaultSelected {
		t.Fatalf("tree change not detected: %+v", preview.Candidates)
	}
	updated := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if updated.Failed || updated.Results[0].SkillID != report.Results[0].SkillID {
		t.Fatalf("tree update: %+v", updated)
	}
	var folder string
	fx.QueryRow(t, "SELECT f.package_path FROM labrastro_skill_folder f JOIN labrastro_skill_placement p ON p.folder_id=f.id WHERE p.skill_id=$1", report.Results[0].SkillID).Scan(&folder)
	if folder != "group" {
		t.Fatalf("common-prefix layout = %q, want group", folder)
	}
	var scan LabrastroPackagePreview
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{"url": source.url() + "/tree/v2"}, "packageId", report.Package.ID).Want(200).JSON(&scan)
	if scan.Source["ref"] != "v2" || scan.Package.Ref != "main" {
		t.Fatalf("ref switch not visible in preview: %+v", scan)
	}
	var switched LabrastroPackageApplyResult
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{"url": source.url() + "/tree/v2", "apply": true, "preview_id": scan.PreviewID}, "packageId", report.Package.ID).Want(200).JSON(&switched)
	if switched.Package.Ref != "v2" {
		t.Fatal("apply did not persist switched ref")
	}
	source.paths = nil
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{}, "packageId", report.Package.ID).Want(200)
	for _, p := range source.paths {
		if p == "/repos/fixture/skills?" || strings.Contains(p, "/commits/main?") {
			t.Fatalf("rescan consulted the default branch instead of saved ref: %v", source.paths)
		}
	}
	// Another subdirectory of the same repository has an independent identity
	// and gets a distinct default root name, even if no item can be transferred.
	subURL := source.url() + "/tree/main/skills/other"
	preview = labrastroPreview(t, fx, testUserID, subURL)
	sub := labrastroApply(t, fx, testUserID, subURL, preview.PreviewID, nil)
	if sub.Failed || sub.Package.ID == report.Package.ID || fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE workspace_id=$1 AND parent_id IS NULL", fx.WorkspaceID) != 2 {
		t.Fatalf("subdirectory root conflict: %+v", sub)
	}
}

func TestLabrastroPackageDeleteAtomicAndDetachedSurvival(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/group/alpha/SKILL.md": "---\nname: alpha\n---\nalpha", "skills/other/beta/SKILL.md": "---\nname: beta\n---\nbeta"})
	source.install(t)
	p := labrastroPreview(t, fx, testUserID, source.url())
	report := labrastroApply(t, fx, testUserID, source.url(), p.PreviewID, nil)
	if report.Failed {
		t.Fatalf("setup import: %+v", report)
	}
	alpha, beta := report.Results[0].SkillID, report.Results[1].SkillID
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDetachSkill, "POST", nil, "skillId", alpha).Want(200)
	runtimeID := fx.Runtime(t, "delete runtime")
	agent := fx.Agent(t, "affected agent", runtimeID)
	fx.InsertNoID(t, "agent_skill", testutil.Cols{"agent_id": agent, "skill_id": beta}, "agent_id=$1 AND skill_id=$2", agent, beta)
	var impact struct {
		PreviewID string `json:"preview_id"`
	}
	labrastroCall(t, fx, testUserID, testHandler.LabrastroPackageDeletePreview, "GET", nil, "packageId", report.Package.ID).Want(200).JSON(&impact)
	// Force a late failure while removing managed folder markers. Earlier
	// skill/binding deletes must roll back together with package metadata.
	constraint := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	fx.Exec(t, fmt.Sprintf("ALTER TABLE labrastro_skill_folder ADD CONSTRAINT %s CHECK (workspace_id <> '%s'::uuid OR package_id IS NOT NULL) NOT VALID", constraint, fx.WorkspaceID))
	fx.Cleanup(t, "ALTER TABLE labrastro_skill_folder DROP CONSTRAINT IF EXISTS "+constraint)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDeletePackage, "DELETE", map[string]string{"preview_id": impact.PreviewID}, "packageId", report.Package.ID).Want(500)
	if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1", beta) != 1 || fx.Count(t, "SELECT count(*) FROM agent_skill WHERE skill_id=$1", beta) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE id=$1", report.Package.ID) != 1 {
		t.Fatal("failed delete left partially removed objects")
	}
	fx.Exec(t, "ALTER TABLE labrastro_skill_folder DROP CONSTRAINT "+constraint)
	labrastroCall(t, fx, testUserID, testHandler.LabrastroDeletePackage, "DELETE", map[string]string{"preview_id": impact.PreviewID}, "packageId", report.Package.ID).Want(200)
	if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1", beta) != 0 || fx.Count(t, "SELECT count(*) FROM agent_skill WHERE skill_id=$1", beta) != 0 || fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1", alpha) != 1 {
		t.Fatal("delete affected detached skill or left bindings")
	}
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE workspace_id=$1 AND package_id IS NULL", fx.WorkspaceID) != 2 {
		t.Fatal("delete did not preserve only detached skill's folder ancestors")
	}
}

func TestLabrastroPackageConcurrentApply(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\nalpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Go(func() {
			req := newRequestAsUser(testUserID, "POST", "/api/skill-packages/apply", map[string]any{"url": source.url(), "preview_id": preview.PreviewID})
			req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
			w := httptest.NewRecorder()
			testHandler.LabrastroApplyPackage(w, req)
			if w.Code == 200 {
				var result LabrastroPackageApplyResult
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result.Failed {
					t.Errorf("winning apply failed: %s", w.Body.String())
				}
			}
			codes <- w.Code
		})
	}
	wg.Wait()
	a, b := <-codes, <-codes
	if !(a == 200 && b == 409 || a == 409 && b == 200) || fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE workspace_id=$1", fx.WorkspaceID) != 1 {
		t.Fatalf("concurrent apply duplicated data: statuses %d %d", a, b)
	}
}

func TestLabrastroWorkspaceDeleteCleansSkillTree(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	other := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\nalpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	if result := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil); result.Failed {
		t.Fatalf("setup import failed: %+v", result)
	}
	labrastroCall(t, other, testUserID, testHandler.LabrastroCreateFolder, "POST", map[string]string{"name": "survives"}).Want(201)
	labrastroCall(t, fx, testUserID, testHandler.DeleteWorkspace, "DELETE", nil, "id", fx.WorkspaceID).Want(204)
	for _, table := range []string{"labrastro_skill_folder", "labrastro_skill_package", "labrastro_skill_placement"} {
		if fx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
			t.Fatalf("workspace delete left %s rows", table)
		}
	}
	if other.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE workspace_id=$1", other.WorkspaceID) != 1 {
		t.Fatal("workspace deletion crossed the workspace boundary")
	}
}

func TestLabrastroRenamedImportRescan(t *testing.T) {
	for _, tc := range []struct{ path, name, header string }{
		{"skills/alpha/SKILL.md", "alpha", "---\nname: alpha\n---\n"},
		{"skills/alpha/SKILL.md", "alpha", ""},
		{"SKILL.md", "skills", ""},
	} {
		t.Run(tc.path+tc.header, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": tc.name, "content": "other source", "created_by": testUserID})
			source := labrastroTestFixture(map[string]string{tc.path: tc.header + "original"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"on_conflict": "rename"})
			if report.Failed || report.Results[0].Status != "created" {
				t.Fatalf("initial rename: %+v", report)
			}
			id := report.Results[0].SkillID
			var name string
			fx.QueryRow(t, "SELECT name FROM skill WHERE id=$1", id).Scan(&name)
			if name != tc.name+"-2" {
				t.Fatalf("initial name = %q", name)
			}
			preview = labrastroPreview(t, fx, testUserID, source.url())
			if preview.Candidates[0].State != "unchanged" || preview.Candidates[0].DefaultSelected {
				t.Fatalf("local rename treated as source change: %+v", preview.Candidates)
			}
			if report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil); report.Failed {
				t.Fatalf("unchanged rescan: %+v", report)
			}
			labrastroCall(t, fx, testUserID, testHandler.LabrastroDetachSkill, "POST", nil, "skillId", id).Want(200)
			preview = labrastroPreview(t, fx, testUserID, source.url())
			if preview.Candidates[0].State != "adoptable" || preview.Candidates[0].DefaultSelected {
				t.Fatalf("detached candidate: %+v", preview.Candidates)
			}
			report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"skills": []string{preview.Candidates[0].Path}})
			fx.QueryRow(t, "SELECT name FROM skill WHERE id=$1", id).Scan(&name)
			if report.Failed || report.Results[0].SkillID != id || name != tc.name+"-2" {
				t.Fatalf("readoption lost local name or identity: name=%q report=%+v", name, report)
			}
			// A local display name is independent of source frontmatter. Content
			// updates must preserve it, including skills with inferred names.
			fx.Exec(t, "UPDATE skill SET name='local-display-name' WHERE id=$1", id)
			preview = labrastroPreview(t, fx, testUserID, source.url())
			if preview.Candidates[0].State != "unchanged" {
				t.Fatalf("display rename alone marked changed: %+v", preview.Candidates)
			}
			source.Files[tc.path] = tc.header + "updated contents"
			source.rebuild()
			preview = labrastroPreview(t, fx, testUserID, source.url())
			report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
			if report.Failed || report.Results[0].SkillID != id || report.Results[0].Status != "updated" {
				t.Fatalf("content update: %+v", report)
			}
			fx.QueryRow(t, "SELECT name FROM skill WHERE id=$1", id).Scan(&name)
			if name != "local-display-name" {
				t.Fatalf("content update lost local name: %q", name)
			}
			// Metadata advances even for deselected or failed items. It must
			// not hide an unapplied upstream rename on the next retry.
			source.Files[tc.path] = "---\nname: upstream-renamed\n---\nnew name"
			source.rebuild()
			blocker := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "upstream-renamed", "content": "collision", "created_by": testUserID})
			preview = labrastroPreview(t, fx, testUserID, source.url())
			labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"skills": []string{}})
			for range 2 {
				preview = labrastroPreview(t, fx, testUserID, source.url())
				report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
				if !report.Failed || report.Results[0].Code != "name_conflict" {
					t.Fatalf("upstream rename lost after metadata apply: %+v", report)
				}
			}
			fx.Exec(t, "UPDATE skill SET name='collision-resolved' WHERE id=$1", blocker)
			preview = labrastroPreview(t, fx, testUserID, source.url())
			report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
			fx.QueryRow(t, "SELECT name FROM skill WHERE id=$1", id).Scan(&name)
			if report.Failed || report.Results[0].SkillID != id || name != "upstream-renamed" {
				t.Fatalf("upstream rename did not preserve ID: name=%s report=%+v", name, report)
			}
			preview = labrastroPreview(t, fx, testUserID, source.url())
			if preview.Candidates[0].State != "unchanged" {
				t.Fatalf("successful rename still changed: %+v", preview.Candidates)
			}
		})
	}
}

func TestLabrastroPackagedNameConflictAllowsRename(t *testing.T) {
	for _, moved := range []bool{false, true} {
		t.Run(fmt.Sprintf("directory_moved=%t", moved), func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			oldPath := "skills/old/alpha"
			newPath := oldPath
			source := labrastroTestFixture(map[string]string{oldPath + "/SKILL.md": "---\nname: alpha\n---\noriginal"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			original := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
			if original.Failed {
				t.Fatalf("original import: %+v", original)
			}
			id := original.Results[0].SkillID
			if moved {
				newPath = "skills/new/alpha"
				delete(source.Files, oldPath+"/SKILL.md")
			} else {
				source.Repo = "other-repo"
			}
			source.Files[newPath+"/SKILL.md"] = "---\nname: alpha\n---\nnew source"
			source.rebuild()
			preview = labrastroPreview(t, fx, testUserID, source.url())
			for _, c := range preview.Candidates {
				if c.Path == newPath && (c.Conflict != "name_conflict" || c.CanWrite) {
					t.Fatalf("name match misclassified or overwrite allowed: %+v", c)
				}
			}
			// Even the creator cannot overwrite a skill in a managed package.
			report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"skills": []string{newPath}, "on_conflict": "overwrite"})
			if !report.Failed {
				t.Fatalf("overwrote a packaged target: %+v", report)
			}
			preview = labrastroPreview(t, fx, testUserID, source.url())
			report = labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"skills": []string{newPath}, "on_conflict": "rename"})
			if report.Failed {
				t.Fatalf("name-conflict rename failed: %+v", report)
			}
			var newID string
			for _, item := range report.Results {
				if item.Path == newPath {
					if item.Status != "created" || item.SkillID == id {
						t.Fatalf("rename transferred original: %+v", item)
					}
					newID = item.SkillID
				}
			}
			if newID == "" || fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 2 {
				t.Fatalf("expected original plus renamed copy: %+v", report)
			}
			var originalPath, originalPackage, originalContent string
			fx.QueryRow(t, "SELECT p.source_path,p.package_id::text,s.content FROM labrastro_skill_placement p JOIN skill s ON s.id=p.skill_id WHERE p.skill_id=$1", id).Scan(&originalPath, &originalPackage, &originalContent)
			if originalPath != oldPath || originalPackage != original.Package.ID || !strings.HasSuffix(originalContent, "original") {
				t.Fatal("name-conflict operation modified the original packaged skill")
			}
		})
	}
}

func TestLabrastroAlreadyPackagedDefaultUnselected(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "---\nname: alpha\n---\noriginal"})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	original := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	subURL := source.url() + "/tree/main/skills"
	preview = labrastroPreview(t, fx, testUserID, subURL)
	c := preview.Candidates[0]
	if c.Conflict != "already_packaged" || c.DefaultSelected || c.CanWrite {
		t.Fatalf("same-source transfer offered as default: %+v", c)
	}
	report := labrastroApply(t, fx, testUserID, subURL, preview.PreviewID, nil)
	if report.Failed || report.Package != nil {
		t.Fatalf("default selection created an empty package: %+v", report)
	}
	preview = labrastroPreview(t, fx, testUserID, subURL)
	report = labrastroApply(t, fx, testUserID, subURL, preview.PreviewID, map[string]any{"all": true, "on_conflict": "rename"})
	if !report.Failed || report.Results[0].Code != "already_packaged" || report.Results[0].SkillID != original.Results[0].SkillID {
		t.Fatalf("same-source transfer was allowed: %+v", report)
	}
}
