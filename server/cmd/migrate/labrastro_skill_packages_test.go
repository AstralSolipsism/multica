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

func TestLabrastroSkillPackageMigrationsUpDownAndInterruptedIndex(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	schema := "skill_packages_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, table := range []string{"labrastro_skill_placement", "labrastro_skill_package", "labrastro_skill_folder", "schema_migrations"} {
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
		"9001_labrastro_skill_packages", "9002_labrastro_skill_folder_id_index",
		"9003_labrastro_skill_package_id_index", "9004_labrastro_skill_package_source_index",
		"9005_labrastro_skill_placement_skill_index", "9006_labrastro_skill_placement_source_index",
		"9007_labrastro_skill_folder_source_index", "9008_labrastro_skill_folder_sibling_index",
	}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions[:1], "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO labrastro_skill_folder (id,workspace_id,name)
SELECT '00000000-0000-0000-0000-000000000001',gen_random_uuid(),'folder' FROM generate_series(1,2)`); err != nil {
		t.Fatal(err)
	}
	opts.Files = realMigrationFiles(t, versions, "up")
	if err := runMigrations(ctx, pool, opts); err == nil {
		t.Fatal("duplicate folder IDs did not stop unique index build")
	}
	assertIndexValidity(t, pool, schema, "idx_labrastro_skill_folder_id", false)
	if _, err := pool.Exec(ctx, "DELETE FROM labrastro_skill_folder WHERE ctid IN (SELECT ctid FROM labrastro_skill_folder LIMIT 1)"); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertIndexValidity(t, pool, schema, "idx_labrastro_skill_folder_id", true)
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
	assertIndexValidity(t, pool, schema, "idx_labrastro_skill_folder_sibling", true)
}
