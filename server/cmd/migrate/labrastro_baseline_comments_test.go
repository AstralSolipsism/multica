package main

import (
	"context"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestLabrastroBaselineCommentMigrationsRoundTrip(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	schema := "baseline_comments_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"project_baseline_comment", "project_baseline_thread", "schema_migrations"} {
			if _, err := admin.Exec(context.Background(), "DROP TABLE IF EXISTS "+quoted+"."+table); err != nil {
				t.Error(err)
			}
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	versions := []string{"9071_labrastro_baseline_comment_tables", "9072_labrastro_baseline_thread_identity_index", "9073_labrastro_baseline_thread_page_index", "9074_labrastro_baseline_comment_identity_index", "9075_labrastro_baseline_comment_thread_index"}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions[:1], "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	// Simulate an interrupted concurrent unique build, then prove recovery uses
	// the registered invalid-index cleanup and rebuilds the index.
	if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_thread(id,workspace_id,project_id,page_id,anchor_kind,section_anchor,created_by_type,created_by_id) SELECT '00000000-0000-0000-0000-000000000001',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'section','A','member',gen_random_uuid() FROM generate_series(1,2)`); err != nil {
		t.Fatal(err)
	}
	opts.Files = realMigrationFiles(t, versions, "up")
	if err := runMigrations(ctx, pool, opts); err == nil {
		t.Fatal("duplicates did not fail unique build")
	}
	assertIndexValidity(t, pool, schema, "idx_baseline_thread_identity", false)
	if _, err := pool.Exec(ctx, `DELETE FROM project_baseline_thread WHERE ctid IN (SELECT ctid FROM project_baseline_thread LIMIT 1)`); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	for _, index := range []string{"idx_baseline_thread_identity", "idx_baseline_thread_page", "idx_baseline_comment_identity", "idx_baseline_comment_thread"} {
		assertIndexValidity(t, pool, schema, index, true)
	}
	baselineWikiColumnNotNull(t, pool, schema, "project_baseline_comment", "author_id")
	// Down applies only our own tables; a second up is a pristine installation.
	for _, direction := range []string{"down", "up"} {
		opts.Direction = direction
		opts.Hooks = hooksForDirection(direction)
		opts.Files = realMigrationFiles(t, versions, direction)
		if err := runMigrations(ctx, pool, opts); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_baseline_thread)+(SELECT count(*) FROM project_baseline_comment)`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("fresh install n=%d err=%v", n, err)
	}
}
