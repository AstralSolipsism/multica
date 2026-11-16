package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type migrationFixture struct {
	source, target *testutil.Fixture
	snapshot       labrastroOrganizationSnapshot
	skills         map[string]string
}

func newMigrationFixture(t *testing.T) migrationFixture {
	t.Helper()
	src, dst := labrastroPackageDBFixture(t), labrastroPackageDBFixture(t)
	ids := map[string]string{}
	sourceSkills := map[string]string{}
	for _, fx := range []*testutil.Fixture{src, dst} {
		for _, name := range []string{"alpha", "ordinary", "detached"} {
			config := map[string]any{"private_setting": "never-export-this"}
			if name == "alpha" {
				config["origin"] = map[string]any{"type": "github", "owner": "example", "repo": "skills", "path": "skills/tools/alpha", "ref": "release/v2", "source_url": "https://github.com/example/skills/tree/release/v2/skills/tools/alpha"}
			}
			var skill SkillWithFilesResponse
			labrastroCall(t, fx, testUserID, testHandler.CreateSkill, "POST", CreateSkillRequest{Name: name, Description: "description " + name, Content: "body " + name, Config: config, Files: []CreateSkillFileRequest{{Path: "notes.md", Content: "support " + name}}}).Want(201).JSON(&skill)
			if fx == src {
				sourceSkills[name] = skill.ID
			} else {
				ids[name] = skill.ID
			}
		}
	}
	group := src.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": src.WorkspaceID, "name": "Group"})
	nested := src.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": src.WorkspaceID, "name": "Nested", "parent_id": group})
	pkg := uuid.NewString()
	root := src.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": src.WorkspaceID, "name": "Renamed package", "parent_id": nested, "package_id": pkg, "package_path": ""})
	sub := src.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": src.WorkspaceID, "name": "tools", "parent_id": root, "package_id": pkg, "package_path": "tools"})
	src.Insert(t, "labrastro_skill_package", testutil.Cols{"id": pkg, "workspace_id": src.WorkspaceID, "owner_repo": "example/skills", "source_url": "https://github.com/example/skills/tree/release/v2", "source_ref": "release/v2", "root_folder_id": root, "created_by": testUserID, "candidates": `[{"path":"skills/tools/alpha","name":"alpha","description":"saved"},{"path":"skills/unimported","name":"unimported","description":"gray candidate"}]`})
	for name, sid := range sourceSkills {
		cols := testutil.Cols{"workspace_id": src.WorkspaceID, "skill_id": sid, "folder_id": nested}
		if name != "ordinary" {
			cols["folder_id"] = sub
		}
		if name == "alpha" {
			cols["package_id"] = pkg
			cols["source_path"] = "skills/tools/alpha"
		}
		src.InsertNoID(t, "labrastro_skill_placement", cols, "workspace_id=$1 AND skill_id=$2", src.WorkspaceID, sid)
	}
	old := dst.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": dst.WorkspaceID, "name": "Target only"})
	dst.InsertNoID(t, "labrastro_skill_placement", testutil.Cols{"workspace_id": dst.WorkspaceID, "skill_id": ids["ordinary"], "folder_id": old}, "workspace_id=$1 AND skill_id=$2", dst.WorkspaceID, ids["ordinary"])
	only := dst.Insert(t, "skill", testutil.Cols{"workspace_id": dst.WorkspaceID, "name": "target-only", "content": "keep", "created_by": testUserID})
	dst.InsertNoID(t, "labrastro_skill_placement", testutil.Cols{"workspace_id": dst.WorkspaceID, "skill_id": only, "folder_id": old}, "workspace_id=$1 AND skill_id=$2", dst.WorkspaceID, only)
	ownPkg := uuid.NewString()
	ownRoot := dst.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": dst.WorkspaceID, "name": "Own package", "package_id": ownPkg, "package_path": ""})
	dst.Insert(t, "labrastro_skill_package", testutil.Cols{"id": ownPkg, "workspace_id": dst.WorkspaceID, "owner_repo": "target/only", "source_url": "https://github.com/target/only/tree/main", "source_ref": "main", "root_folder_id": ownRoot, "created_by": testUserID})
	runtime := dst.Runtime(t, "migration runtime")
	agent := dst.Agent(t, "migration agent", runtime)
	for name, sid := range ids {
		dst.InsertNoID(t, "agent_skill", testutil.Cols{"agent_id": agent, "skill_id": sid, "enabled": name != "detached"}, "agent_id=$1 AND skill_id=$2", agent, sid)
	}
	label := dst.Insert(t, "issue_label", testutil.Cols{"workspace_id": dst.WorkspaceID, "name": "keep label", "color": "red"})
	dst.InsertNoID(t, "skill_to_label", testutil.Cols{"skill_id": ids["alpha"], "label_id": label}, "skill_id=$1 AND label_id=$2", ids["alpha"], label)
	var snapshot labrastroOrganizationSnapshot
	labrastroCall(t, src, testUserID, testHandler.LabrastroExportSkillOrganization, "GET", nil).Want(200).JSON(&snapshot)
	return migrationFixture{src, dst, snapshot, ids}
}
func migrationPreview(t *testing.T, h *Handler, fx *testutil.Fixture, s labrastroOrganizationSnapshot) labrastroMigrationPlan {
	t.Helper()
	var p labrastroMigrationPlan
	labrastroCall(t, fx, testUserID, h.LabrastroPreviewSkillMigration, "POST", map[string]any{"snapshot": s}).Want(200).JSON(&p)
	return p
}
func migrationApply(t *testing.T, h *Handler, fx *testutil.Fixture, s labrastroOrganizationSnapshot, token string, status int) *testutil.Response {
	t.Helper()
	return labrastroCall(t, fx, testUserID, h.LabrastroApplySkillMigration, "POST", map[string]any{"snapshot": s, "preview_id": token}).Want(status)
}
func migrationRows(t *testing.T, fx *testutil.Fixture, organization bool) string {
	t.Helper()
	queries := []string{
		"SELECT to_jsonb(s) FROM skill s WHERE workspace_id=$1 ORDER BY id",
		"SELECT to_jsonb(f) FROM skill_file f JOIN skill s ON s.id=f.skill_id WHERE s.workspace_id=$1 ORDER BY f.id",
		"SELECT to_jsonb(v) FROM skill_version v WHERE workspace_id=$1 ORDER BY id",
		"SELECT to_jsonb(b) FROM agent_skill b JOIN skill s ON s.id=b.skill_id WHERE s.workspace_id=$1 ORDER BY b.agent_id,b.skill_id",
		"SELECT to_jsonb(l) FROM skill_to_label l JOIN skill s ON s.id=l.skill_id WHERE s.workspace_id=$1 ORDER BY l.skill_id,l.label_id",
	}
	if organization {
		queries = []string{"SELECT to_jsonb(f) FROM labrastro_skill_folder f WHERE workspace_id=$1 ORDER BY id", "SELECT to_jsonb(p) FROM labrastro_skill_package p WHERE workspace_id=$1 ORDER BY id", "SELECT to_jsonb(p) FROM labrastro_skill_placement p WHERE workspace_id=$1 ORDER BY skill_id"}
	}
	result := []json.RawMessage{}
	for _, sql := range queries {
		rows, err := testPool.Query(t.Context(), sql, fx.WorkspaceID)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var raw json.RawMessage
			if err = rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			result = append(result, raw)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	return labrastroJSONHash(result)
}

type migrationNoNetwork struct{ t *testing.T }

func (n migrationNoNetwork) RoundTrip(r *http.Request) (*http.Response, error) {
	n.t.Errorf("migration accessed network: %s", r.URL.Host)
	return nil, errors.New("network unavailable")
}
func TestLabrastroMigrationRoundTrip(t *testing.T) {
	old := http.DefaultTransport
	http.DefaultTransport = migrationNoNetwork{t}
	t.Cleanup(func() { http.DefaultTransport = old })
	f := newMigrationFixture(t)
	h := *testHandler
	h.Bus = events.New()
	broadcasts := 0
	h.Bus.Subscribe(protocol.EventSkillUpdated, func(e events.Event) {
		if e.WorkspaceID != f.target.WorkspaceID || e.Payload.(map[string]any)["organization_migrated"] != true {
			t.Errorf("wrong event: %+v", e)
		}
		broadcasts++
	})
	raw, _ := json.Marshal(f.snapshot)
	for _, secret := range []string{"body alpha", "support alpha", "never-export-this", "agent_skill"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("snapshot leaked %s", secret)
		}
	}
	immutable := migrationRows(t, f.target, false)
	before := migrationRows(t, f.target, true)
	p := migrationPreview(t, &h, f.target, f.snapshot)
	if !p.CanApply || p.Summary["place"] != 2 || p.Summary["move"] != 1 || p.Summary["target_only_skills"] != 1 || p.Summary["target_only_packages"] != 1 {
		t.Fatalf("unexpected preview: %+v", p)
	}
	if before != migrationRows(t, f.target, true) || broadcasts != 0 {
		t.Fatal("preview mutated organization or published event")
	}
	var applied labrastroMigrationPlan
	migrationApply(t, &h, f.target, f.snapshot, p.PreviewID, 200).JSON(&applied)
	if !applied.Changed || broadcasts != 1 {
		t.Fatalf("missing change/event: %+v broadcasts=%d", applied, broadcasts)
	}
	if immutable != migrationRows(t, f.target, false) {
		t.Fatal("migration changed skill bodies/config/files/history/labels/bindings")
	}
	for _, place := range applied.Placements {
		if uuidToString(place.SkillID) != f.skills[place.Skill.Name] || place.SkillID == place.SourceSkillID {
			t.Fatalf("wrong target skill mapping: %+v", place)
		}
	}
	for _, folder := range applied.Folders {
		if folder.ID == folder.SourceID {
			t.Fatal("copied source folder UUID")
		}
	}
	var exported labrastroOrganizationSnapshot
	labrastroCall(t, f.target, testUserID, h.LabrastroExportSkillOrganization, "GET", nil).Want(200).JSON(&exported)
	if len(exported.Folders) != 6 || len(exported.Packages) != 2 || len(exported.Placements) != 4 {
		t.Fatalf("lost source or target-only objects: %+v", exported)
	}
	before = migrationRows(t, f.target, true)
	// A fresh preview permits an idempotent apply; the old token is stale after writes.
	migrationApply(t, &h, f.target, f.snapshot, p.PreviewID, 409)
	p = migrationPreview(t, &h, f.target, f.snapshot)
	begins, writes := 0, 0
	h.TxStarter = labrastroQueryHookStarter{h.TxStarter, func(sql string) {
		for _, word := range []string{"INSERT INTO", "UPDATE ", "DELETE FROM"} {
			if strings.Contains(sql, word) {
				writes++
			}
		}
	}, &begins}
	migrationApply(t, &h, f.target, f.snapshot, p.PreviewID, 200).JSON(&applied)
	if applied.Changed || writes != 0 || begins != 1 || broadcasts != 1 || before != migrationRows(t, f.target, true) {
		t.Fatalf("non-idempotent apply: changed=%v writes=%d tx=%d events=%d", applied.Changed, writes, begins, broadcasts)
	}
	if immutable != migrationRows(t, f.target, false) {
		t.Fatal("idempotent apply changed immutable data")
	}
}
func TestLabrastroMigrationUpdatesExistingPackage(t *testing.T) {
	f := newMigrationFixture(t)
	p := migrationPreview(t, testHandler, f.target, f.snapshot)
	migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
	var pkg db.LabrastroSkillPackage
	pkg, err := testHandler.Queries.LabrastroGetSkillPackage(t.Context(), db.LabrastroGetSkillPackageParams{WorkspaceID: parseUUID(f.target.WorkspaceID), ID: p.Packages[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	for i := range f.snapshot.Folders {
		if f.snapshot.Folders[i].ID == f.snapshot.Packages[0].RootFolderID {
			f.snapshot.Folders[i].Name = "Changed root"
			f.snapshot.Folders[i].ParentID = pgtype.UUID{}
		}
	}
	f.snapshot.Packages[0].Candidates = append(f.snapshot.Packages[0].Candidates, labrastroSkillCandidateSummary{Path: "new", Name: "new"})
	immutable := migrationRows(t, f.target, false)
	p = migrationPreview(t, testHandler, f.target, f.snapshot)
	if !p.CanApply || p.Summary["update"] != 2 {
		t.Fatalf("root/candidates update: %+v", p)
	}
	migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
	got, err := testHandler.Queries.LabrastroGetSkillPackage(t.Context(), db.LabrastroGetSkillPackageParams{WorkspaceID: pkg.WorkspaceID, ID: pkg.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got.CreatedBy != pkg.CreatedBy || got.Revision != pkg.Revision+1 || immutable != migrationRows(t, f.target, false) {
		t.Fatal("package update changed ownership or contents")
	}
	p = migrationPreview(t, testHandler, f.target, f.snapshot)
	var out labrastroMigrationPlan
	migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200).JSON(&out)
	if out.Changed {
		t.Fatal("repeat root update was not a no-op")
	}
}
func TestLabrastroMigrationConflicts(t *testing.T) {
	cases := []struct {
		name, code string
		change     func(*testing.T, *migrationFixture)
	}{
		{"different content", "source_mismatch", func(t *testing.T, f *migrationFixture) {
			f.target.Exec(t, "UPDATE skill SET content='different' WHERE id=$1", f.skills["ordinary"])
		}},
		{"different source", "source_mismatch", func(t *testing.T, f *migrationFixture) {
			f.target.Exec(t, `UPDATE skill SET config='{"origin":{"type":"github","owner":"other","repo":"skills","path":"alpha"}}' WHERE id=$1`, f.skills["alpha"])
		}},
		{"source on local skill", "source_mismatch", func(t *testing.T, f *migrationFixture) {
			f.target.Exec(t, `UPDATE skill SET config='{"origin":{"type":"github","owner":"other","repo":"skills","path":"alpha"}}' WHERE id=$1`, f.skills["ordinary"])
		}},
		{"ambiguous origin", "ambiguous_target_skill", func(t *testing.T, f *migrationFixture) {
			f.target.Insert(t, "skill", testutil.Cols{"workspace_id": f.target.WorkspaceID, "name": "alpha-copy", "content": "copy", "created_by": testUserID, "config": `{"origin":{"type":"github","owner":"example","repo":"skills","path":"skills/tools/alpha"}}`})
		}},
		{"two source skills", "ambiguous_target_skill", func(t *testing.T, f *migrationFixture) {
			for _, p := range f.snapshot.Placements {
				if p.Skill.Name == "alpha" {
					p.SkillID = labrastroNewID()
					p.PackageID = pgtype.UUID{}
					p.SourcePath = nil
					f.snapshot.Placements = append(f.snapshot.Placements, p)
					break
				}
			}
		}},
		{"already packaged", "already_packaged", func(t *testing.T, f *migrationFixture) {
			f.target.Exec(t, `INSERT INTO labrastro_skill_placement SELECT workspace_id,$2,root_folder_id,id,'different' FROM labrastro_skill_package WHERE workspace_id=$1`, f.target.WorkspaceID, f.skills["alpha"])
		}},
		{"folder collision", "folder_name_conflict", func(t *testing.T, f *migrationFixture) {
			f.target.Exec(t, "UPDATE labrastro_skill_folder SET name='Group' WHERE workspace_id=$1 AND package_id IS NOT NULL", f.target.WorkspaceID)
		}},
		{"package ref", "package_ref_mismatch", func(t *testing.T, f *migrationFixture) {
			f.target.Exec(t, "UPDATE labrastro_skill_package SET owner_repo='example/skills' WHERE workspace_id=$1", f.target.WorkspaceID)
		}},
		{"skill permission", "forbidden", func(t *testing.T, f *migrationFixture) {
			other := f.target.User(t, "other", uuid.NewString()+"@example.com")
			f.target.Exec(t, "UPDATE skill SET created_by=$1 WHERE id=$2", other, f.skills["ordinary"])
			f.target.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.target.WorkspaceID, testUserID)
		}},
		{"package permission", "forbidden", func(t *testing.T, f *migrationFixture) {
			p := migrationPreview(t, testHandler, f.target, f.snapshot)
			migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
			other := f.target.User(t, "other", uuid.NewString()+"@example.com")
			f.target.Exec(t, "UPDATE labrastro_skill_package SET created_by=$1 WHERE workspace_id=$2", other, f.target.WorkspaceID)
			f.target.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.target.WorkspaceID, testUserID)
			f.snapshot.Packages[0].Candidates = append(f.snapshot.Packages[0].Candidates, labrastroSkillCandidateSummary{Path: "new", Name: "new"})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newMigrationFixture(t)
			tc.change(t, &f)
			before := migrationRows(t, f.target, true)
			immutable := migrationRows(t, f.target, false)
			p := migrationPreview(t, testHandler, f.target, f.snapshot)
			found := false
			for _, c := range p.Conflicts {
				if c.Code == tc.code {
					found = true
				}
			}
			if p.CanApply || !found {
				t.Fatalf("wanted %s: %+v", tc.code, p)
			}
			var out struct {
				Code string
				Plan labrastroMigrationPlan
			}
			migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 409).JSON(&out)
			if out.Code != "migration_conflict" || len(out.Plan.Conflicts) == 0 || before != migrationRows(t, f.target, true) || immutable != migrationRows(t, f.target, false) {
				t.Fatal("conflict applied partial changes or lost report")
			}
		})
	}
}
func TestLabrastroMigrationValidation(t *testing.T) {
	f := newMigrationFixture(t)
	cases := []struct {
		name, code string
		change     func(*labrastroOrganizationSnapshot)
	}{
		{"schema", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) { s.SchemaVersion = 2 }},
		{"zero id", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) { s.Folders[0].ID = pgtype.UUID{Valid: true} }},
		{"duplicate id", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) { s.Folders = append(s.Folders, s.Folders[0]) }},
		{"sibling name", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) {
			f := s.Folders[0]
			f.ID = labrastroNewID()
			s.Folders = append(s.Folders, f)
		}},
		{"parent missing", "dangling_reference", func(s *labrastroOrganizationSnapshot) { s.Folders[0].ParentID = labrastroNewID() }},
		{"self cycle", "folder_cycle", func(s *labrastroOrganizationSnapshot) { s.Folders[0].ParentID = s.Folders[0].ID }},
		{"multi cycle", "folder_cycle", func(s *labrastroOrganizationSnapshot) {
			s.Folders[0].ParentID = s.Folders[1].ID
			s.Folders[1].ParentID = s.Folders[0].ID
		}},
		{"root missing", "invalid_package_root", func(s *labrastroOrganizationSnapshot) { s.Packages[0].RootFolderID = labrastroNewID() }},
		{"root nested in package", "invalid_package_root", func(s *labrastroOrganizationSnapshot) {
			pkg := labrastroNewID()
			root := labrastroNewID()
			empty := ""
			p := s.Packages[0]
			p.ID = pkg
			p.RootFolderID = root
			p.OwnerRepo = "other/skills"
			p.SourceURL = "https://github.com/other/skills/tree/release/v2"
			s.Packages = append(s.Packages, p)
			s.Folders = append(s.Folders, labrastroMigrationFolder{ID: root, ParentID: s.Packages[0].RootFolderID, Name: "illegal", PackageID: pkg, PackagePath: &empty})
		}},
		{"custom inside package", "managed_folder", func(s *labrastroOrganizationSnapshot) {
			s.Folders = append(s.Folders, labrastroMigrationFolder{ID: labrastroNewID(), ParentID: s.Packages[0].RootFolderID, Name: "illegal"})
		}},
		{"bad managed path", "invalid_package_root", func(s *labrastroOrganizationSnapshot) {
			for i := range s.Folders {
				if s.Folders[i].PackagePath != nil && *s.Folders[i].PackagePath != "" {
					bad := "../escape"
					s.Folders[i].PackagePath = &bad
				}
			}
		}},
		{"bad URL", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) {
			s.Packages[0].SourceURL = "https://user:secret@github.com/example/skills/tree/release/v2"
		}},
		{"candidate duplicate", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) {
			s.Packages[0].Candidates = append(s.Packages[0].Candidates, s.Packages[0].Candidates[0])
		}},
		{"candidate traversal", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) { s.Packages[0].Candidates[0].Path = "../escape" }},
		{"placement folder", "dangling_reference", func(s *labrastroOrganizationSnapshot) { s.Placements[0].FolderID = labrastroNewID() }},
		{"foreign folder", "dangling_reference", func(s *labrastroOrganizationSnapshot) {
			s.Placements[0].FolderID = parseUUID(f.target.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": f.target.WorkspaceID, "name": uuid.NewString()}))
		}},
		{"placement package", "dangling_reference", func(s *labrastroOrganizationSnapshot) {
			for i := range s.Placements {
				if s.Placements[i].PackageID.Valid {
					s.Placements[i].PackageID = labrastroNewID()
				}
			}
		}},
		{"duplicate skill", "invalid_snapshot", func(s *labrastroOrganizationSnapshot) { s.Placements = append(s.Placements, s.Placements[0]) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := json.Marshal(f.snapshot)
			var s labrastroOrganizationSnapshot
			_ = json.Unmarshal(b, &s)
			tc.change(&s)
			before := migrationRows(t, f.target, true)
			for _, h := range []http.HandlerFunc{testHandler.LabrastroPreviewSkillMigration, testHandler.LabrastroApplySkillMigration} {
				var failure struct{ Code string }
				labrastroCall(t, f.target, testUserID, h, "POST", map[string]any{"snapshot": s}).Want(422).JSON(&failure)
				if failure.Code != tc.code {
					t.Fatalf("got %s want %s", failure.Code, tc.code)
				}
			}
			if before != migrationRows(t, f.target, true) {
				t.Fatal("invalid snapshot wrote rows")
			}
		})
	}
	for _, body := range []string{`{"snapshot":{},"unexpected":true}`, `{} {}`, `{"snapshot":{"schema_version":1,"unknown":true}}`, strings.Repeat(" ", 8<<20) + "{}"} {
		r := newRequestAsUser(testUserID, "POST", "/api/skill-folders/migrate/preview", nil)
		r.Body = io.NopCloser(strings.NewReader(body))
		r.Header.Set("X-Workspace-ID", f.target.WorkspaceID)
		testutil.Call(t, testHandler.LabrastroPreviewSkillMigration, r).Want(400)
	}
}
func TestLabrastroMigrationStaleAndRollback(t *testing.T) {
	for _, mode := range []string{"forged", "expired", "source", "target", "role", "caller", "workspace", "constraint", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newMigrationFixture(t)
			h := *testHandler
			h.Bus = events.New()
			broadcasts := 0
			h.Bus.Subscribe(protocol.EventSkillUpdated, func(events.Event) { broadcasts++ })
			p := migrationPreview(t, &h, f.target, f.snapshot)
			token := p.PreviewID
			switch mode {
			case "forged":
				token += "x"
			case "expired":
				token = labrastroSignPreview(strings.Split(token, ".")[0], time.Now().Add(-time.Minute).Unix())
			case "source":
				f.snapshot.ExportedAt = f.snapshot.ExportedAt.Add(time.Second)
			case "target":
				f.target.Exec(t, "UPDATE skill SET content='changed after preview' WHERE id=$1", f.skills["alpha"])
			case "role":
				f.target.Exec(t, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", f.target.WorkspaceID, testUserID)
			case "workspace":
				f.target = labrastroPackageDBFixture(t)
			case "constraint":
				constraint := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
				f.target.Exec(t, fmt.Sprintf("ALTER TABLE labrastro_skill_placement ADD CONSTRAINT %s CHECK (workspace_id <> '%s'::uuid OR skill_id <> '%s'::uuid) NOT VALID", constraint, f.target.WorkspaceID, f.skills["alpha"]))
				f.target.Cleanup(t, "ALTER TABLE labrastro_skill_placement DROP CONSTRAINT "+constraint)
			}
			before := migrationRows(t, f.target, true)
			immutable := migrationRows(t, f.target, false)
			req := newRequestAsUser(testUserID, "POST", "/api/skill-folders/migrate/apply", map[string]any{"snapshot": f.snapshot, "preview_id": token})
			req.Header.Set("X-Workspace-ID", f.target.WorkspaceID)
			if mode == "caller" {
				user := f.target.User(t, "other", uuid.NewString()+"@example.com")
				f.target.Member(t, f.target.WorkspaceID, user, "owner")
				req.Header.Set("X-User-ID", user)
			}
			if mode == "cancel" {
				ctx, cancel := context.WithCancel(req.Context())
				defer cancel()
				req = req.WithContext(ctx)
				begins := 0
				h.TxStarter = labrastroQueryHookStarter{h.TxStarter, func(sql string) {
					if strings.Contains(sql, "name: LabrastroPlaceSkill") {
						cancel()
					}
				}, &begins}
			}
			status := 409
			if mode == "constraint" || mode == "cancel" {
				status = 500
			}
			var failure struct{ Code string }
			testutil.Call(t, h.LabrastroApplySkillMigration, req).Want(status).JSON(&failure)
			if status == 409 && failure.Code != "preview_stale" {
				t.Fatalf("wrong stale error: %+v", failure)
			}
			if before != migrationRows(t, f.target, true) || immutable != migrationRows(t, f.target, false) || broadcasts != 0 {
				t.Fatal("failed migration left partial changes or broadcast")
			}
		})
	}
}
func TestLabrastroMigrationLegacyAndMissingSkills(t *testing.T) {
	f := newMigrationFixture(t)
	f.target.Exec(t, `UPDATE skill SET name='renamed alpha',config='{"origin":{"type":"skills_sh","owner":"EXAMPLE","repo":"SKILLS","source_url":"https://skills.sh/example/skills/alpha"}}' WHERE id=$1`, f.skills["alpha"])
	f.target.Exec(t, "UPDATE skill SET name='different local' WHERE id=$1", f.skills["detached"])
	p := migrationPreview(t, testHandler, f.target, f.snapshot)
	if !p.CanApply || p.Summary["skipped"] != 1 {
		t.Fatalf("legacy/missing: %+v", p)
	}
	migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
	// Package-path match wins over another skill with the same origin.
	f.target.Insert(t, "skill", testutil.Cols{"workspace_id": f.target.WorkspaceID, "name": "another alpha", "content": "other", "created_by": testUserID, "config": `{"origin":{"type":"github","owner":"example","repo":"skills","path":"skills/tools/alpha"}}`})
	p = migrationPreview(t, testHandler, f.target, f.snapshot)
	if !p.CanApply {
		t.Fatalf("existing package path should disambiguate: %+v", p)
	}
}
func TestLabrastroMigrationRoutesRespectTaskScope(t *testing.T) {
	f := newMigrationFixture(t)
	runtime := f.source.Runtime(t, "token runtime")
	agent := f.source.Agent(t, "token agent", runtime)
	task := f.source.Task(t, agent, testutil.Cols{"runtime_id": runtime, "status": "running", "originator_user_id": testUserID, "accountable_user_id": testUserID, "originator_source": "direct_human"})
	token, err := auth.GenerateAgentTaskToken()
	if err != nil {
		t.Fatal(err)
	}
	f.source.Insert(t, "task_token", testutil.Cols{"token_hash": auth.HashToken(token), "task_id": task, "agent_id": agent, "workspace_id": f.source.WorkspaceID, "user_id": testUserID, "expires_at": time.Now().Add(time.Hour)})
	router := chi.NewRouter()
	router.Use(middleware.Auth(testHandler.Queries, nil, nil, nil))
	router.Use(middleware.RequireWorkspaceMember(testHandler.Queries))
	testHandler.RegisterLabrastroSkillRoutes(router)
	for _, route := range []struct{ method, path string }{{"GET", "/api/skill-folders/snapshot"}, {"POST", "/api/skill-folders/migrate/preview"}, {"POST", "/api/skill-folders/migrate/apply"}} {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Workspace-ID", f.target.WorkspaceID)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 403 || !strings.Contains(w.Body.String(), "different workspace") {
			t.Fatalf("cross-workspace route %s: %d %s", route.path, w.Code, w.Body.String())
		}
		req = httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer mat_retired_conversation_token")
		req.Header.Set("X-Workspace-ID", f.source.WorkspaceID)
		w = httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("revoked token accessed route %s: %d", route.path, w.Code)
		}
	}
	req := httptest.NewRequest("GET", "/api/skill-folders/snapshot", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Workspace-ID", f.source.WorkspaceID)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("same-workspace export failed: %d %s", w.Code, w.Body.String())
	}
}

func TestLabrastroMigrationPreservesRenamedTargetOnlyFolder(t *testing.T) {
	f := newMigrationFixture(t)
	p := migrationPreview(t, testHandler, f.target, f.snapshot)
	migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
	var original pgtype.UUID
	for _, folder := range p.Folders {
		if folder.Name == "Group" {
			original = folder.ID
		}
	}
	f.target.Exec(t, "UPDATE labrastro_skill_folder SET name='Locally renamed' WHERE id=$1", original)
	p = migrationPreview(t, testHandler, f.target, f.snapshot)
	if !p.CanApply {
		t.Fatalf("rename should create a separate source path: %+v", p)
	}
	migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
	if f.target.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE id=$1 AND name='Locally renamed'", original) != 1 {
		t.Fatal("migration overwrote target-only folder")
	}
}

func TestLabrastroMigrationExportRedactsOriginCredentials(t *testing.T) {
	f := newMigrationFixture(t)
	f.source.Exec(t, `UPDATE skill SET config=jsonb_set(config,'{origin}',config->'origin' || '{"token":"private-token","source_url":"https://user:private-password@github.com/example/skills/tree/main/alpha?key=private-query#private-fragment"}') WHERE workspace_id=$1 AND name='alpha'`, f.source.WorkspaceID)
	var out labrastroOrganizationSnapshot
	labrastroCall(t, f.source, testUserID, testHandler.LabrastroExportSkillOrganization, "GET", nil).Want(200).JSON(&out)
	raw, _ := json.Marshal(out)
	for _, secret := range []string{"private-token", "private-password", "private-query", "private-fragment", "never-export-this"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("snapshot exposed %s", secret)
		}
	}
}

func TestLabrastroMigrationExistingRootConflicts(t *testing.T) {
	for _, mode := range []string{"collision", "permission"} {
		t.Run(mode, func(t *testing.T) {
			f := newMigrationFixture(t)
			p := migrationPreview(t, testHandler, f.target, f.snapshot)
			migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 200)
			for i := range f.snapshot.Folders {
				if f.snapshot.Folders[i].ID == f.snapshot.Packages[0].RootFolderID {
					f.snapshot.Folders[i].Name = "Target only"
					f.snapshot.Folders[i].ParentID = pgtype.UUID{}
				}
			}
			code := "folder_name_conflict"
			if mode == "permission" {
				code = "forbidden"
				other := f.target.User(t, "package owner", uuid.NewString()+"@example.com")
				f.target.Exec(t, "UPDATE labrastro_skill_package SET created_by=$1 WHERE workspace_id=$2", other, f.target.WorkspaceID)
				f.target.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", f.target.WorkspaceID, testUserID)
			}
			before := migrationRows(t, f.target, true)
			p = migrationPreview(t, testHandler, f.target, f.snapshot)
			found := false
			for _, c := range p.Conflicts {
				if c.Code == code {
					found = true
				}
			}
			if p.CanApply || !found {
				t.Fatalf("expected %s: %+v", code, p)
			}
			migrationApply(t, testHandler, f.target, f.snapshot, p.PreviewID, 409)
			if before != migrationRows(t, f.target, true) {
				t.Fatal("root conflict changed metadata")
			}
		})
	}
}
