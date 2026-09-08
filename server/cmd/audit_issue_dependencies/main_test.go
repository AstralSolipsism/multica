package main

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestDependencyLegacyNormalizationAndRestore(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL is required for isolated PostgreSQL integration")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close(ctx) })
	schema := "dep_audit_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, name := range []string{"issue_dependency", "issue", "workspace"} {
			if _, err := admin.Exec(ctx, "DROP TABLE IF EXISTS "+quoted+"."+pgx.Identifier{name}.Sanitize()); err != nil {
				t.Error(err)
			}
		}
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+quoted); err != nil {
			t.Error(err)
		}
	})
	for _, name := range []string{"workspace", "issue", "issue_dependency"} {
		if _, err := admin.Exec(ctx, "CREATE TABLE "+quoted+"."+pgx.Identifier{name}.Sanitize()+" (LIKE public."+pgx.Identifier{name}.Sanitize()+" INCLUDING DEFAULTS)"); err != nil {
			t.Fatal(err)
		}
	}
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("search_path", schema+",public")
	u.RawQuery = query.Encode()
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	fx := testutil.New(pool, "", util.UUIDToString(dbid.NewV7()))
	fx.WorkspaceID = fx.Insert(t, "workspace", testutil.Cols{"name": "audit", "slug": "audit", "issue_prefix": "AUD"})
	a := fx.Issue(t, "A")
	b := fx.Issue(t, "B")
	first := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": a, "type": "blocked_by"})
	second := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": a, "type": "blocked_by"})
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": a, "depends_on_issue_id": b, "type": "related"})
	path := filepath.Join(t.TempDir(), "backup.json")
	if err := run(ctx, u.String(), true, path, ""); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved backup
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Audit.Total != 3 || len(saved.Audit.DuplicateIDs) != 1 || len(saved.Audit.Normalized) != 2 {
		t.Fatalf("wrong impact counts: %+v", saved.Audit)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM issue_dependency").Scan(&count); err != nil || count != 2 {
		t.Fatalf("normalization rows=%d err=%v", count, err)
	}
	if err := run(ctx, u.String(), true, path, ""); err == nil {
		t.Fatal("existing backup was overwritten")
	}
	if err := run(ctx, u.String(), false, "", path); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM issue_dependency WHERE id IN ($1,$2)", first, second).Scan(&count); err != nil || count != 2 {
		t.Fatalf("original row identities were not restored: %d %v", count, err)
	}
	// A changed graph cannot be overwritten with an old backup.
	fx.Exec(t, "UPDATE issue_dependency SET type='related' WHERE id=$1", first)
	if err := run(ctx, u.String(), false, "", path); err == nil {
		t.Fatal("restore overwrote newer relation data")
	}
	fx.Exec(t, "UPDATE issue_dependency SET type='blocks' WHERE id=$1", second)
	if err := run(ctx, u.String(), true, filepath.Join(t.TempDir(), "unknown.json"), ""); err == nil {
		t.Fatal("unknown historical direction was normalized")
	}
}
