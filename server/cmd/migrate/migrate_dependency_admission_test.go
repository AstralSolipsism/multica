package main

import (
	"context"
	"errors"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestDependencyAdmissionMigrationPreservesTasksAndUniqueness(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	schema := "dependency_admission_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"agent_task_queue", "schema_migrations"} {
			if _, err := admin.Exec(context.Background(), "DROP TABLE IF EXISTS "+quoted+"."+pgx.Identifier{table}.Sanitize()); err != nil {
				t.Error(err)
			}
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, "CREATE TABLE agent_task_queue (id UUID NOT NULL DEFAULT gen_random_uuid(), status TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	fx := testutil.New(pool, "", "")
	first := fx.Insert(t, "agent_task_queue", testutil.Cols{"status": "queued"})
	second := fx.Insert(t, "agent_task_queue", testutil.Cols{"status": "completed"})
	versions := []string{"467_task_dependency_admission", "468_task_dependency_request_index"}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertIndexValidity(t, pool, schema, "idx_task_dependency_request", true)
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE dependency_admission IS NULL").Scan(&count)
	if count != 2 {
		t.Fatal("migration rewrote historical admission")
	}
	fx.Exec(t, `UPDATE agent_task_queue SET dependency_admission='{"request_id":"one-confirmation"}' WHERE id=$1`, first)
	_, err := pool.Exec(ctx, `UPDATE agent_task_queue SET dependency_admission='{"request_id":"one-confirmation"}' WHERE id=$1`, second)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("duplicate confirmation was admitted: %v", err)
	}
	fx.Exec(t, `UPDATE agent_task_queue SET dependency_admission='{"consumed_at":"2026-09-08T00:00:00Z"}' WHERE id=$1`, second)
	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, []string{versions[1], versions[0]}, "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	fx.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE (id=$1 AND status='queued') OR (id=$2 AND status='completed')", first, second).Scan(&count)
	if count != 2 {
		t.Fatal("rollback changed existing tasks")
	}
	opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, versions, "up"), hooksForDirection("up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
}
