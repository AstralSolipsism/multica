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

func TestLabrastroPackagePreviewMarkdownDeadline(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"backticks", "x" + strings.Repeat("`", (1<<20)-1)},
		{"nested containers", strings.Repeat(">", 1<<17)},
		{"reference definitions", strings.Repeat("[x]:a\n", (1<<20)/6)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			labrastroPreviewMarkdownDeadline(t, tc.body)
		})
	}
}

func labrastroPreviewMarkdownDeadline(t *testing.T, body string) {
	t.Helper()
	fx := labrastroPackageDBFixture(t)
	source := labrastroTestFixture(map[string]string{
		"skills/demo/SKILL.md":  body,
		"skills/demo/notes.txt": "notes",
	})
	source.install(t)
	// Warm only the large blob, without scanning it. The small support-file
	// response below leaves a short, predictable budget for Markdown scanning.
	src, err := newLabrastroSkillSource(t.Context(), source.client(), source.url(), fx.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := src.fetch(t.Context(), "skills/demo/SKILL.md"); err != nil {
		t.Fatal(err)
	}
	before := labrastroPackageSnapshotHash(t, fx)
	req := newRequestAsUser(testUserID, "POST", "/api/skill-packages/preview", map[string]any{"url": source.url()})
	req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	ctx, cancel := context.WithTimeout(req.Context(), 500*time.Millisecond)
	defer cancel()
	deadline, _ := ctx.Deadline()
	reached := false
	http.DefaultTransport = labrastroPackageTransport(func(r *http.Request) (*http.Response, error) {
		response, err := (labrastroFixtureTransport{source}).RoundTrip(r)
		if err == nil && r.URL.Host == "raw.githubusercontent.com" && strings.HasSuffix(r.URL.Path, "/notes.txt") {
			reached = true
			timer := time.NewTimer(time.Until(deadline) - 5*time.Millisecond)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
			}
		}
		return response, err
	})
	var failure struct {
		Code      string `json:"code"`
		Retryable bool   `json:"retryable"`
	}
	start := time.Now()
	testutil.Call(t, testHandler.LabrastroPreviewPackage, req.WithContext(ctx)).Want(http.StatusGatewayTimeout).JSON(&failure)
	elapsed := time.Since(start)
	if !reached || failure.Code != "source_timeout" || !failure.Retryable {
		t.Fatalf("wrong scan deadline response (reached=%v): %+v", reached, failure)
	}
	if elapsed >= 2*time.Second {
		t.Fatalf("500ms preview deadline returned after %s; want less than 2s", elapsed)
	}
	if after := labrastroPackageSnapshotHash(t, fx); before != after {
		t.Fatal("interrupted preview changed database state")
	}
	t.Logf("500ms preview deadline returned 504 in %s", elapsed)
}

func TestLabrastroMarkdownParagraphLimitResponses(t *testing.T) {
	for _, file := range []string{"skills/demo/SKILL.md", "references/guide.md"} {
		t.Run(file, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			const header = "---\nname: demo\n---\n"
			files := map[string]string{"skills/demo/SKILL.md": header + "[guide](../../references/guide.md)"}
			files[file] = strings.Repeat("[x]:a\n", (maxImportFileSize-len(header))/6)
			if file == "skills/demo/SKILL.md" {
				files[file] = header + files[file]
			}
			source := labrastroTestFixture(files)
			source.install(t)
			before := labrastroPackageSnapshotHash(t, fx)
			start := time.Now()
			preview := labrastroPreview(t, fx, testUserID, source.url())
			elapsed := time.Since(start)
			if len(preview.Candidates) != 1 {
				t.Fatalf("preview returned %d candidates, want one failed candidate", len(preview.Candidates))
			}
			c := preview.Candidates[0]
			if c.State != "failed" || c.CanWrite || c.DefaultSelected || len(c.Diagnostics) != 1 || c.Diagnostics[0].Code != "limit_exceeded" || c.Diagnostics[0].Retryable || c.Diagnostics[0].Path != file {
				t.Fatalf("paragraph limit lost candidate diagnostic: %+v", c)
			}
			if elapsed >= 2*time.Second {
				t.Fatalf("paragraph limit preview took %s; want less than 2s", elapsed)
			}
			var failure struct {
				Code        string                  `json:"code"`
				Retryable   bool                    `json:"retryable"`
				Diagnostics []SkillImportDiagnostic `json:"diagnostics"`
			}
			labrastroCall(t, fx, testUserID, testHandler.ImportSkill, "POST", map[string]string{"url": source.url() + "/tree/main/skills/demo"}).Want(http.StatusRequestEntityTooLarge).JSON(&failure)
			if failure.Code != "limit_exceeded" || failure.Retryable || len(failure.Diagnostics) != 1 || failure.Diagnostics[0].Path != file {
				t.Fatalf("legacy import lost paragraph-limit diagnostic: %+v", failure)
			}
			if after := labrastroPackageSnapshotHash(t, fx); before != after {
				t.Fatal("rejected Markdown changed database state")
			}
			t.Logf("paragraph limit preview returned failed candidate in %s; legacy import returned 413", elapsed)
		})
	}
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
				// Model a cold instance/cache eviction before a source failure.
				labrastroEvictWorkspaceBlobs(fx.WorkspaceID)
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
			// The network failure contract still applies on a cold instance.
			labrastroEvictWorkspaceBlobs(fx.WorkspaceID)
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
