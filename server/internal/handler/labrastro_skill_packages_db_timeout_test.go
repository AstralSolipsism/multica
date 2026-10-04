package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Observe the actual SQL boundary without replacing PostgreSQL execution.
type labrastroQueryHookStarter struct {
	txStarter
	beforeQuery func(string)
	begins      *int
}

func (s labrastroQueryHookStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	*s.begins++
	tx, err := s.txStarter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return labrastroQueryHookTx{tx, s.beforeQuery}, nil
}

type labrastroQueryHookTx struct {
	pgx.Tx
	beforeQuery func(string)
}

func (tx labrastroQueryHookTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.beforeQuery(sql)
	return tx.Tx.Exec(ctx, sql, args...)
}

func (tx labrastroQueryHookTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	tx.beforeQuery(sql)
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func TestLabrastroPackageItemTransactionContextFailure(t *testing.T) {
	for _, interruption := range []string{"deadline", "cancel"} {
		t.Run(interruption, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{
				"skills/alpha/SKILL.md": "alpha",
				"skills/beta/SKILL.md":  "old beta",
				"skills/beta/notes.md":  "old support",
				"skills/zulu/SKILL.md":  "zulu",
			})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			initial := labrastroApply(t, fx, testUserID, source.url(), preview.PreviewID, map[string]any{
				"skills": []string{"skills/beta"},
			})
			if initial.Failed || len(initial.Results) != 3 || initial.Results[1].Status != "created" {
				t.Fatalf("could not prepare the existing target: %+v", initial)
			}
			target := initial.Results[1].SkillID
			source.Files["skills/beta/SKILL.md"] = "new beta"
			source.Files["skills/beta/notes.md"] = "new support"
			source.rebuild()
			preview = labrastroPreview(t, fx, testUserID, source.url())
			if preview.Candidates[1].State != "changed" {
				t.Fatalf("target must require a transaction: %+v", preview.Candidates[1])
			}

			lock, err := testPool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(context.Background())
			if _, err = lock.Exec(t.Context(), "SELECT id FROM skill WHERE id=$1 FOR UPDATE", target); err != nil {
				t.Fatal(err)
			}

			req := newRequestAsUser(testUserID, "POST", "/api/skill-packages", map[string]any{
				"url": source.url(), "preview_id": preview.PreviewID, "all": true,
			})
			req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
			ctx, cancel := context.WithTimeout(req.Context(), time.Second)
			defer cancel()
			h := *testHandler
			begins, commits, locks := 0, 0, 0
			h.TxStarter = labrastroAfterCommitStarter{labrastroQueryHookStarter{h.TxStarter, func(sql string) {
				if strings.Contains(sql, "-- name: LabrastroLockSkill :one") {
					locks++
					if interruption == "cancel" {
						cancel()
					}
				}
			}, &begins}, func() { commits++ }}
			var report LabrastroPackageApplyResult
			testutil.Call(t, h.LabrastroApplyPackage, req.WithContext(ctx)).Want(http.StatusOK).JSON(&report)
			wantErr := context.DeadlineExceeded
			if interruption == "cancel" {
				wantErr = context.Canceled
			}
			if !errors.Is(ctx.Err(), wantErr) || locks != 1 || begins != 3 || commits != 2 {
				t.Fatalf("did not interrupt the target transaction exactly once: err=%v locks=%d begins=%d commits=%d", ctx.Err(), locks, begins, commits)
			}
			if !report.Failed || report.Package == nil || len(report.Results) != 3 || report.Results[0].Status != "created" {
				t.Fatalf("lost committed success or complete report: %+v", report)
			}
			for _, item := range report.Results[1:] {
				if item.Status != "failed" || item.Code != "source_timeout" || !item.Retryable || item.Reason != wantErr.Error() {
					t.Errorf("database interruption misclassified: %+v", item)
				}
			}
			if report.Results[1].SkillID != target ||
				fx.Count(t, "SELECT count(*) FROM skill WHERE id=$1 AND content='old beta'", target) != 1 ||
				fx.Count(t, "SELECT count(*) FROM skill_file WHERE skill_id=$1 AND path='notes.md' AND content='old support'", target) != 1 ||
				fx.Count(t, "SELECT count(*) FROM skill WHERE workspace_id=$1", fx.WorkspaceID) != 2 ||
				fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE workspace_id=$1", fx.WorkspaceID) != 2 {
				t.Fatal("database does not match the successful and rolled-back report items")
			}
		})
	}
}

func TestLabrastroPackageTransactionLockContextFailure(t *testing.T) {
	for _, interruption := range []string{"deadline", "cancel"} {
		t.Run(interruption, func(t *testing.T) {
			fx := labrastroPackageDBFixture(t)
			source := labrastroTestFixture(map[string]string{"skills/alpha/SKILL.md": "alpha"})
			source.install(t)
			preview := labrastroPreview(t, fx, testUserID, source.url())
			before := labrastroPackageSnapshotHash(t, fx)
			lock, err := testPool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(context.Background())
			if _, err = lock.Exec(t.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 9001))", fx.WorkspaceID); err != nil {
				t.Fatal(err)
			}

			req := newRequestAsUser(testUserID, "POST", "/api/skill-packages", map[string]any{
				"url": source.url(), "preview_id": preview.PreviewID, "all": true,
			})
			req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
			ctx, cancel := context.WithTimeout(req.Context(), time.Second)
			defer cancel()
			h := *testHandler
			begins, commits, locks := 0, 0, 0
			h.TxStarter = labrastroAfterCommitStarter{labrastroQueryHookStarter{h.TxStarter, func(sql string) {
				if strings.Contains(sql, "-- name: LabrastroLockSkillWorkspace :exec") {
					locks++
					if interruption == "cancel" {
						cancel()
					}
				}
			}, &begins}, func() { commits++ }}
			var failure struct {
				Code      string `json:"code"`
				Retryable bool   `json:"retryable"`
			}
			response := testutil.Call(t, h.LabrastroApplyPackage, req.WithContext(ctx))
			wantErr := context.DeadlineExceeded
			if interruption == "cancel" {
				wantErr = context.Canceled
			}
			if !errors.Is(ctx.Err(), wantErr) || locks != 1 || begins != 1 || commits != 0 {
				t.Fatalf("did not interrupt the package lock exactly once: err=%v locks=%d begins=%d commits=%d", ctx.Err(), locks, begins, commits)
			}
			response.Want(http.StatusGatewayTimeout).JSON(&failure)
			if failure.Code != "source_timeout" || !failure.Retryable {
				t.Fatalf("package lock interruption misclassified: %+v", failure)
			}
			if after := labrastroPackageSnapshotHash(t, fx); before != after {
				t.Fatal("package transaction failure changed database state")
			}
		})
	}
}
