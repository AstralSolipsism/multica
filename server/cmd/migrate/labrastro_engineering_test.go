package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestLabrastroEngineeringMigrationsUpDownAndInterruptedIndex(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	schema := "engineering_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"project_baseline_revision", "project_baseline_doc", "project_engineering", "schema_migrations"} {
			if _, err := admin.Exec(context.Background(), "DROP TABLE IF EXISTS "+quoted+"."+table); err != nil {
				t.Error(err)
			}
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	versions := []string{
		"9039_labrastro_engineering_tables",
		"9040_labrastro_engineering_config_identity_index",
		"9041_labrastro_engineering_doc_identity_index",
		"9042_labrastro_engineering_doc_chapter_index",
		"9043_labrastro_engineering_revision_identity_index",
		"9044_labrastro_engineering_revision_number_index",
		"9045_labrastro_engineering_candidate_index",
	}

	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions[:1], "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_engineering (workspace_id,project_id,updated_by_type,updated_by_id)
SELECT '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member',gen_random_uuid() FROM generate_series(1,2)`); err != nil {
		t.Fatal(err)
	}
	opts.Files = realMigrationFiles(t, versions, "up")
	if err := runMigrations(ctx, pool, opts); err == nil {
		t.Fatal("duplicate project configurations did not stop unique index build")
	}
	assertIndexValidity(t, pool, schema, "idx_project_engineering_identity", false)
	if _, err := pool.Exec(ctx, "DELETE FROM project_engineering WHERE ctid IN (SELECT ctid FROM project_engineering LIMIT 1)"); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertIndexValidity(t, pool, schema, "idx_project_engineering_identity", true)
	reversed := slices.Clone(versions)
	slices.Reverse(reversed)
	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, reversed, "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, versions, "up"), hooksForDirection("up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertIndexValidity(t, pool, schema, "idx_project_baseline_candidate", true)
}
