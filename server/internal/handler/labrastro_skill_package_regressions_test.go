package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLabrastroPackageRejectsSelectionOutsidePreview(t *testing.T) {
	for _, paths := range [][]string{{"missing"}, {"alpha", "missing"}} {
		t.Run(strings.Join(paths, "+"), func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "---\nname: alpha\n---\nalpha"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			var failure struct{ Error string }
			labrastroCall(t, fx, testUserID, testHandler.LabrastroApplyPackage, "POST", map[string]any{
				"url": source.url(), "preview_id": preview.PreviewID, "skills": paths,
			}).Want(http.StatusBadRequest).JSON(&failure)
			if failure.Error != "selected skill path is not in this preview" {
				t.Fatalf("unexpected selection error: %+v", failure)
			}
			for _, table := range []string{"labrastro_skill_package", "labrastro_skill_folder", "labrastro_skill_placement", "skill"} {
				if n := fx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", fx.WorkspaceID); n != 0 {
					t.Fatalf("invalid selection wrote %d rows to %s", n, table)
				}
			}
		})
	}
}

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

func TestLabrastroPackageMetadataRechecksOwnershipUnderLock(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	importer := fx.User(t, "importer", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, importer, "member")
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, importer, source.url())
	imported := labrastroApply(t, fx, importer, source.url(), preview.PreviewID, nil)
	if imported.Failed || imported.Package == nil || imported.Package.Ref != "main" {
		t.Fatalf("could not import the original package: %+v", imported)
	}
	var scan LabrastroPackagePreview
	v2 := source.url() + "/tree/v2"
	labrastroCall(t, fx, testUserID, testHandler.LabrastroRescanPackage, "POST", map[string]any{"url": v2}, "packageId", imported.Package.ID).Want(200).JSON(&scan)
	h := *testHandler
	begins := 0
	var afterDemotion string
	h.TxStarter = labrastroObserveBeginStarter{h.TxStarter, func(context.Context) {
		begins++
		if begins == 1 {
			// The non-importer still has permission during the apply's scan.
			fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
			afterDemotion = labrastroPackageSnapshotHash(t, fx)
		}
	}}
	var failure struct {
		Code      string
		Retryable bool
	}
	labrastroCall(t, fx, testUserID, h.LabrastroRescanPackage, "POST", map[string]any{"url": v2, "apply": true, "preview_id": scan.PreviewID}, "packageId", imported.Package.ID).Want(409).JSON(&failure)
	if begins != 1 || failure.Code != "preview_stale" || !failure.Retryable {
		t.Fatalf("metadata ignored the role change between scan and lock: begins=%d failure=%+v", begins, failure)
	}
	if fx.Count(t, "SELECT count(*) FROM labrastro_skill_package WHERE id=$1 AND source_ref='main'", imported.Package.ID) != 1 || afterDemotion != labrastroPackageSnapshotHash(t, fx) {
		t.Fatal("demoted non-importer changed the package ref or persisted other writes")
	}
}

func TestLabrastroPackageItemRechecksPackageOwnershipAfterMetadataCommit(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	importer := fx.User(t, "importer", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, importer, "member")
	source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
	source.install(t)
	preview := labrastroPreview(t, fx, importer, source.url())
	imported := labrastroApply(t, fx, importer, source.url(), preview.PreviewID, nil)
	if imported.Failed || imported.Package == nil {
		t.Fatalf("could not import the original package: %+v", imported)
	}
	source.Files["beta/SKILL.md"] = "beta"
	source.rebuild()
	preview = labrastroPreview(t, fx, testUserID, source.url())
	h := *testHandler
	commits := 0
	var afterDemotion string
	h.TxStarter = labrastroAfterCommitStarter{h.TxStarter, func() {
		commits++
		if commits == 1 {
			fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
			afterDemotion = labrastroPackageSnapshotHash(t, fx)
		}
	}}
	var report LabrastroPackageApplyResult
	labrastroCall(t, fx, testUserID, h.LabrastroApplyPackage, "POST", map[string]any{"url": source.url(), "preview_id": preview.PreviewID, "skills": []string{"beta"}}).Want(200).JSON(&report)
	if commits != 1 || !report.Failed || report.Package == nil || report.Package.ID != imported.Package.ID || len(report.Results) != 2 {
		t.Fatalf("expected only metadata to commit: commits=%d report=%+v", commits, report)
	}
	item := report.Results[1]
	if item.Path != "beta" || item.Status != "failed" || item.Code != "forbidden" || item.Retryable || item.SkillID != "" {
		t.Fatalf("demoted non-importer was not refused a new item: %+v", item)
	}
	if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1 AND name='beta'", fx.WorkspaceID) != 0 || afterDemotion != labrastroPackageSnapshotHash(t, fx) {
		t.Fatal("demoted non-importer wrote into another importer's package")
	}
}

func TestLabrastroPackageItemRechecksRevisionAndSourceAfterMetadataCommit(t *testing.T) {
	for _, tc := range []struct{ name, query string }{
		{"revision", "UPDATE labrastro_skill_package SET revision=revision+1 WHERE workspace_id=$1"},
		{"source_url", "UPDATE labrastro_skill_package SET source_url=source_url || '/other' WHERE workspace_id=$1"},
		{"source_ref", "UPDATE labrastro_skill_package SET source_ref='v2' WHERE workspace_id=$1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			h := *testHandler
			commits := 0
			var afterChange string
			h.TxStarter = labrastroAfterCommitStarter{h.TxStarter, func() {
				commits++
				if commits == 1 {
					fx.Exec(t, tc.query, fx.WorkspaceID)
					afterChange = labrastroPackageSnapshotHash(t, fx)
				}
			}}
			var report LabrastroPackageApplyResult
			labrastroCall(t, fx, testUserID, h.LabrastroApplyPackage, "POST", map[string]any{"url": source.url(), "preview_id": preview.PreviewID}).Want(200).JSON(&report)
			if commits != 1 || !report.Failed || len(report.Results) != 1 {
				t.Fatalf("expected only metadata to commit: commits=%d report=%+v", commits, report)
			}
			item := report.Results[0]
			if item.Path != "alpha" || item.Status != "failed" || item.Code != "preview_stale" || !item.Retryable || item.SkillID != "" {
				t.Fatalf("item ignored a package change after metadata commit: %+v", item)
			}
			if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 0 || afterChange != labrastroPackageSnapshotHash(t, fx) {
				t.Fatal("stale item persisted contents or placement")
			}
		})
	}
}

func TestLabrastroPackageAmbiguousSourceRejectsRenameAndOverwrite(t *testing.T) {
	for _, strategy := range []string{"rename", "overwrite"} {
		t.Run(strategy, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			origin := testutil.Raw(`'{"origin":{"type":"github","owner":"fixture","repo":"skills","path":"alpha"}}'::jsonb`)
			first := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "one", "created_by": testUserID, "config": origin})
			second := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha copy", "content": "two", "created_by": testUserID, "config": origin})
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "---\nname: alpha\n---\nnew"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			if len(preview.Candidates) != 1 || preview.Candidates[0].State != "conflict" || preview.Candidates[0].Conflict != "ambiguous_source" {
				t.Fatalf("expected an ambiguous source: %+v", preview.Candidates)
			}
			report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{"skills": []string{"alpha"}, "on_conflict": strategy})
			if !report.Failed || len(report.Results) != 1 || report.Results[0].Status != "failed" || report.Results[0].Code != "ambiguous_source" || report.Results[0].Retryable {
				t.Fatalf("ambiguous source was not rejected: %+v", report)
			}
			if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 2 || fx.Count(t, "SELECT count(*) FROM skill WHERE (id=$1 AND content='one') OR (id=$2 AND content='two')", first, second) != 2 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
				t.Fatal("ambiguous source created, overwrote or adopted a skill")
			}
		})
	}
}

func TestLabrastroPackageSameBatchSkipDoesNotRename(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{
		"one/SKILL.md": "---\nname: alpha\n---\none",
		"two/SKILL.md": "---\nname: alpha\n---\ntwo",
	})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	if len(preview.Candidates) != 2 || preview.Candidates[0].State != "new" || preview.Candidates[1].State != "new" {
		t.Fatalf("expected two new candidates: %+v", preview.Candidates)
	}
	report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
	if !report.Failed || len(report.Results) != 2 || report.Results[0].Path != "one" || report.Results[0].Status != "created" || report.Results[1].Path != "two" || report.Results[1].Status != "failed" || report.Results[1].Code != "name_conflict" || report.Results[1].Retryable {
		t.Fatalf("default skip must report the same-batch name collision: %+v", report)
	}
	if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 1 || fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1 AND name='alpha' AND content LIKE '%one'", report.Results[0].SkillID) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 1 {
		t.Fatal("default skip renamed the second candidate or changed the first skill")
	}
}

func TestLabrastroPackageSelectedUnchangedStaysUnchanged(t *testing.T) {
	for _, tc := range []struct {
		name      string
		selection map[string]any
	}{
		{"all", map[string]any{"all": true}},
		{"path", map[string]any{"skills": []string{"alpha"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{"alpha/SKILL.md": "alpha"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			imported := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
			if imported.Failed || len(imported.Results) != 1 || imported.Results[0].Status != "created" {
				t.Fatalf("could not import the original skill: %+v", imported)
			}
			preview = labrastroPreview(t, fx, testUserID, source.url())
			if len(preview.Candidates) != 1 || preview.Candidates[0].State != "unchanged" {
				t.Fatalf("expected an unchanged candidate: %+v", preview.Candidates)
			}
			var before, after string
			fx.QueryRow(t, "SELECT row_to_json(s)::text FROM skill s WHERE id=$1", imported.Results[0].SkillID).Scan(&before)
			report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, tc.selection)
			if report.Failed || len(report.Results) != 1 || report.Results[0].Status != "unchanged" || report.Results[0].Code != "" || report.Results[0].SkillID != imported.Results[0].SkillID {
				t.Fatalf("selected unchanged candidate did not remain unchanged: %+v", report)
			}
			fx.QueryRow(t, "SELECT row_to_json(s)::text FROM skill s WHERE id=$1", imported.Results[0].SkillID).Scan(&after)
			if before != after {
				t.Fatal("selected unchanged candidate rewrote the stored skill")
			}
		})
	}
}
