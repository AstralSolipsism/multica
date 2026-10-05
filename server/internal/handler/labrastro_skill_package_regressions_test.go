package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLabrastroPackageNewCandidatesRenameAtWriteTime(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{
		"one/SKILL.md": "---\nname: alpha\n---\none",
		"two/SKILL.md": "---\nname: alpha\n---\ntwo",
	})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	for _, c := range preview.Candidates {
		if c.State != "new" {
			t.Fatalf("expected two new candidates: %+v", preview.Candidates)
		}
	}
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"on_conflict": "rename"})
	if report.Failed || len(report.Results) != 2 || report.Results[0].Status != "created" || report.Results[1].Status != "created" || report.Results[0].SkillID == report.Results[1].SkillID {
		t.Fatalf("same-batch rename must create both skills on the first apply: %+v", report)
	}
	for i, name := range []string{"alpha", "alpha-2"} {
		if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1 AND name=$2", report.Results[i].SkillID, name) != 1 {
			t.Fatalf("candidate %d did not get name %q", i, name)
		}
	}
	source.Files["two/SKILL.md"] += " updated"
	source.rebuild()
	preview = labrastroPreview(t, fx, testUserID, source.url())
	updated := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if preview.Candidates[0].State != "unchanged" || updated.Failed || updated.Results[0].Code != "not_selected" || updated.Results[1].Status != "updated" || updated.Results[1].SkillID != report.Results[1].SkillID {
		t.Fatalf("renamed candidate must retain source identity on rescan: %+v", updated)
	}
	if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1 AND name='alpha-2'", report.Results[1].SkillID) != 1 {
		t.Fatal("rescan lost the conflict suffix")
	}
}

func TestLabrastroPackageUnsafeTreeNamesAreNonRetryableInvalidSources(t *testing.T) {
	for _, filename := range []string{"notes:2026.md", `notes\draft.md`} {
		t.Run(filename, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha", filename: "notes"})
			source.install(t)
			var failure struct {
				Code      string
				Retryable bool
			}
			labrastroCall(t, fx, testUserID, testHandler.LabrastroPreviewPackage, "POST", map[string]string{"url": source.url()}).Want(400).JSON(&failure)
			if failure.Code != "invalid_source" || failure.Retryable {
				t.Fatalf("bad filename misclassified as transient: %+v", failure)
			}
			if fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
				t.Fatal("invalid source persisted a package")
			}
		})
	}
}

func TestLabrastroPackageSymlinkSkillIsDiagnosedWithoutDownloading(t *testing.T) {
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha", "link/SKILL.md": "../alpha/SKILL.md"})
	for i := range source.Tree {
		if source.Tree[i].Path == "link/SKILL.md" {
			source.Tree[i].Mode = "120000"
		}
	}
	src, err := newLabrastroSkillSource(t.Context(), source.client(), source.url(), t.Name())
	if err != nil {
		t.Fatal(err)
	}
	candidates, diagnostics, err := src.candidates(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].Path != "alpha" || len(diagnostics) != 1 || diagnostics[0].Code != "filtered_reference" || diagnostics[0].Path != "link/SKILL.md" || diagnostics[0].Retryable {
		t.Fatalf("symlink should be skipped with a permanent diagnostic: candidates=%+v diagnostics=%+v", candidates, diagnostics)
	}
	for _, request := range source.paths {
		if strings.Contains(request, "/link/SKILL.md") {
			t.Fatalf("downloaded a symlink: %s", request)
		}
	}
}

func TestLabrastroPackageReadsRejectNonMembers(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	outsider := fx.User(t, "outsider", uuid.NewString()+"@example.com")
	for _, endpoint := range []http.HandlerFunc{testHandler.LabrastroSkillTree, testHandler.LabrastroListPackages, testHandler.LabrastroGetPackage} {
		labrastroCall(t, fx, outsider, endpoint, "GET", nil, "packageId", uuid.NewString()).Want(404)
	}
}

func TestLabrastroUnknownCandidateStatesCannotAuthorizeWrites(t *testing.T) {
	for _, c := range []LabrastroSkillCandidate{
		{State: "new", Conflict: "name_conflict"},
		{State: "changed", Conflict: "name_conflict"},
		{State: "adoptable", Conflict: "ambiguous_source"},
		{State: "future_state"},
	} {
		for _, strategy := range []string{"skip", "rename", "overwrite"} {
			decision := labrastroDecideCandidate(c, labrastroPackageRequest{OnConflict: strategy, All: true})
			if status, err := labrastroCandidateTerminal(c, decision); status != "failed" || err == nil {
				t.Fatalf("unknown combination allowed a write: %+v %s", c, strategy)
			}
		}
	}
}

func TestLabrastroPackageItemRechecksTargetAfterMetadataCommit(t *testing.T) {
	for _, change := range []string{"content", "support_file", "placement", "permission"} {
		t.Run(change, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			creator := fx.User(t, "creator", uuid.NewString()+"@example.com")
			sid := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "original", "created_by": creator, "config": testutil.Raw(`'{"origin":{"type":"github","owner":"fixture","repo":"skills","path":"alpha"}}'::jsonb`)})
			fx.Insert(t, "skill_file", testutil.Cols{"skill_id": sid, "path": "notes.md", "content": "original notes"})
			folder := fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "ordinary"})
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "---\nname: alpha\n---\nreplacement"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			h := *testHandler
			commits := 0
			h.TxStarter = labrastroAfterCommitStarter{h.TxStarter, func() {
				commits++
				if commits != 1 {
					return
				}
				switch change {
				case "content":
					fx.Exec(t, "UPDATE skill SET content='concurrent edit' WHERE id=$1", sid)
				case "support_file":
					fx.Exec(t, "UPDATE skill_file SET content='concurrent notes' WHERE skill_id=$1", sid)
				case "placement":
					fx.InsertNoID(t, "labrastro_skill_placement", testutil.Cols{"workspace_id": fx.WorkspaceID, "skill_id": sid, "folder_id": folder}, "workspace_id=$1 AND skill_id=$2", fx.WorkspaceID, sid)
				case "permission":
					fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
				}
			}}
			var report LabrastroPackageApplyResult
			labrastroCall(t, fx, testUserID, h.LabrastroApplyPackage, "POST", map[string]any{"url": source.url(), "preview_id": preview.PreviewID}).Want(200).JSON(&report)
			code := "preview_stale"
			if change == "permission" {
				code = "forbidden"
			}
			if commits != 1 || !report.Failed || len(report.Results) != 1 || report.Results[0].Code != code || report.Results[0].Status != "failed" {
				t.Fatalf("item ignored change after metadata commit: commits=%d report=%+v", commits, report)
			}
			if fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1 AND content LIKE '%replacement%'", sid) != 0 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1 AND package_id IS NOT NULL", sid) != 0 {
				t.Fatal("failed target revalidation wrote contents or package placement")
			}
		})
	}
}
