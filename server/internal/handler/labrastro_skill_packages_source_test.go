package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type labrastroPackageTransport func(*http.Request) (*http.Response, error)

func (f labrastroPackageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func labrastroPackageSnapshotHash(t *testing.T, fx *testutil.Fixture) string {
	t.Helper()
	snap, err := labrastroReadPackageSnapshot(t.Context(), testHandler.Queries, labrastroSkillActor{
		ws: parseUUID(fx.WorkspaceID), user: parseUUID(testUserID),
	})
	if err != nil {
		t.Fatal(err)
	}
	return labrastroJSONHash(snap)
}

func TestLabrastroPackageScanContextFailure(t *testing.T) {
	for _, operation := range []string{"preview", "apply", "rescan"} {
		for _, interruption := range []string{"deadline", "cancel"} {
			t.Run(operation+"/"+interruption, func(t *testing.T) {
				fx := labrastroPackageDBFixture(t)
				source := labrastroTestFixture(map[string]string{
					"skills/alpha/SKILL.md": "alpha",
					"skills/zulu/SKILL.md":  "zulu",
				})
				source.install(t)
				preview := labrastroPreview(t, fx, testUserID, source.url())
				body := map[string]any{"url": source.url(), "preview_id": preview.PreviewID}
				handler := testHandler.LabrastroApplyPackage
				req := newRequestAsUser(testUserID, "POST", "/api/skill-packages", body)
				if operation == "preview" {
					handler = testHandler.LabrastroPreviewPackage
				} else if operation == "rescan" {
					report := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, nil)
					preview = labrastroPreview(t, fx, testUserID, source.url())
					body["preview_id"], body["apply"] = preview.PreviewID, true
					req = testutil.WithURLParams(newRequestAsUser(testUserID, "POST", "/api/skill-packages", body), "packageId", report.Package.ID)
					handler = testHandler.LabrastroRescanPackage
				}
				before := labrastroPackageSnapshotHash(t, fx)
				// Stop in the final candidate, where candidates() used to return
				// a failed row without checking the request context again.
				ctx, cancel := context.WithTimeout(req.Context(), time.Second)
				defer cancel()
				reached := false
				http.DefaultTransport = labrastroPackageTransport(func(r *http.Request) (*http.Response, error) {
					if r.URL.Host == "raw.githubusercontent.com" && strings.HasSuffix(r.URL.Path, "/skills/zulu/SKILL.md") {
						reached = true
						if interruption == "cancel" {
							cancel()
						}
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					return labrastroFixtureTransport{source}.RoundTrip(r)
				})
				req = req.WithContext(ctx)
				req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
				var failure struct {
					Code      string `json:"code"`
					Retryable bool   `json:"retryable"`
				}
				testutil.Call(t, handler, req).Want(http.StatusGatewayTimeout).JSON(&failure)
				if !reached || failure.Code != "source_timeout" || !failure.Retryable {
					t.Fatalf("wrong context failure (reached=%v): %+v", reached, failure)
				}
				if after := labrastroPackageSnapshotHash(t, fx); before != after {
					t.Fatal("interrupted source scan changed database state")
				}
			})
		}
	}
}

func TestLabrastroPackageApplySourceFailureClassification(t *testing.T) {
	for _, tc := range []struct {
		name, failPath string
		existing       bool
		mutate         string
		status         int
		code           string
	}{
		{"primary", "skills/zulu/SKILL.md", false, "", 503, "source_unavailable"},
		{"support", "skills/zulu/notes.md", false, "", 503, "source_unavailable"},
		{"reference", "references/shared.md", false, "", 503, "source_unavailable"},
		{"existing_failure", "references/shared.md", true, "", 200, ""},
		{"source_change", "", false, "source", 409, "preview_stale"},
		{"target_change", "", false, "target", 409, "preview_stale"},
		{"permission_change", "", false, "permission", 409, "preview_stale"},
		{"expired_during_outage", "skills/zulu/SKILL.md", false, "expired", 409, "preview_stale"},
		{"invalid_during_outage", "skills/zulu/SKILL.md", false, "invalid", 409, "preview_stale"},
		{"nonretryable_change", "", false, "limit", 409, "preview_stale"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{
				"skills/alpha/SKILL.md": "alpha",
				"skills/zulu/SKILL.md":  "[shared](../../references/shared.md)",
				"skills/zulu/notes.md":  "notes",
				"references/shared.md":  "shared",
			})
			source.install(t)
			if tc.existing {
				source.failPath = tc.failPath
			}
			preview := labrastroPreview(t, fx, testUserID, source.url())
			source.failPath = tc.failPath
			switch tc.mutate {
			case "source":
				source.Files["skills/zulu/SKILL.md"] = "changed"
				source.rebuild()
			case "target":
				fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "local", "created_by": testUserID})
			case "permission":
				fx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, testUserID)
			case "expired":
				hash, _, _ := strings.Cut(preview.PreviewID, ".")
				preview.PreviewID = labrastroSignPreview(hash, time.Now().Add(-time.Minute).Unix())
			case "invalid":
				preview.PreviewID += "tampered"
			case "limit":
				for i := range source.Tree {
					if source.Tree[i].Path == "skills/zulu/notes.md" {
						source.Tree[i].Size = maxImportFileSize + 1
					}
				}
			}
			before := labrastroPackageSnapshotHash(t, fx)
			response := labrastroCall(t, fx, testUserID, testHandler.LabrastroApplyPackage, "POST", map[string]any{
				"url": source.url(), "preview_id": preview.PreviewID, "all": true,
			}).Want(tc.status)
			if tc.status == 200 {
				var report LabrastroPackageApplyResult
				response.JSON(&report)
				if !report.Failed || len(report.Results) != 2 || report.Results[0].Status != "created" ||
					report.Results[1].Status != "failed" || report.Results[1].Code != "required_reference_unavailable" || !report.Results[1].Retryable {
					t.Fatalf("existing candidate failure lost best-effort report: %+v", report)
				}
				if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 1 ||
					fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 1 {
					t.Fatal("successful and failed items do not match persisted skills/placements")
				}
			} else {
				var failure struct {
					Code      string `json:"code"`
					Retryable bool   `json:"retryable"`
				}
				response.JSON(&failure)
				if failure.Code != tc.code || !failure.Retryable {
					t.Fatalf("wrong source failure: %+v", failure)
				}
				if after := labrastroPackageSnapshotHash(t, fx); before != after {
					t.Fatal("pre-write failure changed database state")
				}
			}
		})
	}
}

type labrastroAfterCommitStarter struct {
	txStarter
	afterCommit func()
}

func (s labrastroAfterCommitStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return labrastroAfterCommitTx{tx, s.afterCommit}, nil
}

type labrastroAfterCommitTx struct {
	pgx.Tx
	afterCommit func()
}

func (tx labrastroAfterCommitTx) Commit(ctx context.Context) error {
	err := tx.Tx.Commit(ctx)
	if err == nil {
		tx.afterCommit()
	}
	return err
}

func TestLabrastroPackageWritePhaseTimeoutReport(t *testing.T) {
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{
		"skills/alpha/SKILL.md": "alpha", "skills/beta/SKILL.md": "beta", "skills/zulu/SKILL.md": "zulu",
	})
	source.install(t)
	preview := labrastroPreview(t, fx, testUserID, source.url())
	req := newRequestAsUser(testUserID, "POST", "/api/skill-packages", map[string]any{
		"url": source.url(), "preview_id": preview.PreviewID, "all": true,
	})
	req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	ctx, cancel := context.WithTimeout(req.Context(), time.Second)
	defer cancel()
	h := *testHandler
	commits := 0
	h.TxStarter = labrastroAfterCommitStarter{h.TxStarter, func() {
		commits++
		if commits == 2 { // Package metadata, then the first skill.
			<-ctx.Done()
		}
	}}
	var report LabrastroPackageApplyResult
	testutil.Call(t, h.LabrastroApplyPackage, req.WithContext(ctx)).Want(200).JSON(&report)
	if !report.Failed || len(report.Results) != 3 || commits != 2 || report.Results[0].Status != "created" {
		t.Fatalf("lost committed success or complete report: %+v (commits=%d)", report, commits)
	}
	for _, item := range report.Results[1:] {
		if item.Status != "failed" || item.Code != "source_timeout" || !item.Retryable {
			t.Fatalf("lost pending timeout result: %+v", item)
		}
	}
	if fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 1 ||
		fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 1 ||
		fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1 AND name='alpha'", report.Results[0].SkillID) != 1 {
		t.Fatal("timeout report does not match committed database state")
	}
}
