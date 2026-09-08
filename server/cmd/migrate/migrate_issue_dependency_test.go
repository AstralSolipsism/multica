package main

import (
	"context"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestDependencyMigrationsPreserveHistoryAndRepairInvalidIndex(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	schema := "dependency_migration_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"issue_dependency", "issue_dependency_audit", "schema_migrations"} {
			if _, err := admin.Exec(context.Background(), "DROP TABLE IF EXISTS "+quoted+"."+pgx.Identifier{table}.Sanitize()); err != nil {
				t.Error(err)
			}
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `CREATE TABLE issue_dependency (id UUID NOT NULL DEFAULT gen_random_uuid(), issue_id UUID NOT NULL, depends_on_issue_id UUID NOT NULL, type TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	ws := util.UUIDToString(dbid.NewV7())
	fx := testutil.New(pool, ws, util.UUIDToString(dbid.NewV7()))
	a, b := util.UUIDToString(dbid.NewV7()), util.UUIDToString(dbid.NewV7())
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": a, "type": "blocked_by"})
	duplicate := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": a, "type": "blocked_by"})
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": a, "depends_on_issue_id": b, "type": "blocks"})
	versions := []string{"463_issue_dependency_audit", "464_issue_dependency_audit_id_index", "465_issue_dependency_audit_workspace_index", "466_issue_dependency_blocked_by_index"}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err == nil {
		t.Fatal("duplicates must stop the unique index migration")
	}
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency").Scan(&count)
	if count != 3 {
		t.Fatal("a failed migration removed historical rows")
	}
	assertIndexValidity(t, pool, schema, "idx_issue_dependency_blocked_by", false)
	// The audit command's separate integration test covers durable backup and
	// exact normalization. Here simulate that authorized repair before retry.
	fx.Exec(t, "DELETE FROM issue_dependency WHERE id=$1", duplicate)
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertIndexValidity(t, pool, schema, "idx_issue_dependency_blocked_by", true)
	fx.Insert(t, "issue_dependency_audit", testutil.Cols{"id": util.UUIDToString(dbid.NewV7()), "workspace_id": ws, "issue_id": b, "credential_kind": "jwt", "action": "write", "before_state": "{}", "after_state": "{}"})
	reversed := append([]string(nil), versions...)
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, reversed, "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency_audit").Scan(&count)
	if count != 1 {
		t.Fatal("rollback removed the audit history")
	}
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency WHERE type='blocks'").Scan(&count)
	if count != 1 {
		t.Fatal("migration reinterpreted a historical blocks edge")
	}
	opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, versions, "up"), hooksForDirection("up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertIndexValidity(t, pool, schema, "idx_issue_dependency_blocked_by", true)
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency_audit").Scan(&count)
	if count != 1 {
		t.Fatal("reapplying migrations lost the retained audit")
	}
}
