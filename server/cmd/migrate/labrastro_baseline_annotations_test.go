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

func TestLabrastroAnnotationMigrationsFreshUpgradeAndRollback(t *testing.T) {
	for _, upgrade := range []bool{false, true} {
		name := "fresh"
		if upgrade {
			name = "upgrade"
		}
		t.Run(name, func(t *testing.T) {
			admin := openTestPool(t)
			ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
			defer cancel()
			schema := "annotations_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
			quoted := pgx.Identifier{schema}.Sanitize()
			if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
				t.Fatal(err)
			}
			pool := openTestPoolWithSearchPath(t, schema)
			t.Cleanup(func() {
				for _, table := range []string{"project_baseline_annotation", "project_baseline_review", "project_baseline_annotation_batch", "project_baseline_revision", "project_baseline_doc", "project_engineering", "schema_migrations"} {
					if _, err := admin.Exec(context.Background(), "DROP TABLE IF EXISTS "+quoted+"."+table); err != nil {
						t.Error(err)
					}
				}
				if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted); err != nil {
					t.Error(err)
				}
			})
			versions := []string{"9049_labrastro_baseline_annotations", "9050_labrastro_baseline_review_client_key_index", "9051_labrastro_baseline_annotation_active_index", "9052_labrastro_baseline_annotation_ordinal_index", "9053_labrastro_baseline_review_batch_index"}
			opts := runOptions{Direction: "up", SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
			if upgrade {
				opts.Files = realMigrationFiles(t, []string{"9039_labrastro_engineering_tables", "9048_labrastro_baseline_module_chapters"}, "up")
				if err := runMigrations(ctx, pool, opts); err != nil {
					t.Fatal(err)
				}
			}
			opts.Files = realMigrationFiles(t, versions, "up")
			if err := runMigrations(ctx, pool, opts); err != nil {
				t.Fatal(err)
			}
			for _, index := range []string{"idx_baseline_review_client_key", "idx_baseline_annotation_active", "idx_baseline_annotation_ordinal", "idx_baseline_review_batch"} {
				assertIndexValidity(t, pool, schema, index, true)
			}
			var batch, review string
			if err := pool.QueryRow(ctx, `INSERT INTO project_baseline_annotation_batch (workspace_id,project_id,chapter,carrier_kind,agent_id,created_by_type,created_by_id) VALUES (gen_random_uuid(),gen_random_uuid(),'module:billing','revision_issue',gen_random_uuid(),'member',gen_random_uuid()) RETURNING id`).Scan(&batch); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `INSERT INTO project_baseline_review (workspace_id,project_id,batch_id,client_key,reviewed_revision_id,created_by_type,created_by_id) SELECT workspace_id,project_id,id,gen_random_uuid(),gen_random_uuid(),'member',created_by_id FROM project_baseline_annotation_batch RETURNING id`).Scan(&review); err != nil {
				t.Fatal(err)
			}
			for _, query := range []string{
				`INSERT INTO project_baseline_annotation_batch SELECT * FROM project_baseline_annotation_batch`,
				`INSERT INTO project_baseline_review SELECT * FROM project_baseline_review`,
				`UPDATE project_baseline_annotation_batch SET chapter='module:Bad'`,
				`UPDATE project_baseline_annotation_batch SET close_reason='manual'`,
				`UPDATE project_baseline_review SET summary=repeat('字',501)`,
			} {
				if _, err := pool.Exec(ctx, query); err == nil {
					t.Fatalf("constraint accepted %s", query)
				}
			}
			if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_annotation (workspace_id,project_id,batch_id,review_id,ordinal,anchor_kind,target_revision_id,target_revision_number,section_anchor,note,created_by_type,created_by_id) SELECT workspace_id,project_id,batch_id,id,1,'section',reviewed_revision_id,1,'RULE-1','note','member',created_by_id FROM project_baseline_review`); err != nil {
				t.Fatal(err)
			}
			for _, set := range []string{"ordinal=0", "ordinal=51", "note=''", "note=repeat('字',1001)", "quote=repeat('字',501)", "prefix=repeat('字',65)", "suffix=repeat('字',65)", "start=-1", "anchor_kind='lines'", "response='response'", "resolved_at=now()", "section_anchor=''"} {
				if _, err := pool.Exec(ctx, "UPDATE project_baseline_annotation SET "+set); err == nil {
					t.Fatalf("constraint accepted %s", set)
				}
			}
			if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_annotation SELECT * FROM project_baseline_annotation`); err == nil {
				t.Fatal("duplicate ordinal accepted")
			}
			reverse := slices.Clone(versions)
			slices.Reverse(reverse)
			opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, reverse, "down"), hooksForDirection("down")
			if err := runMigrations(ctx, pool, opts); err != nil {
				t.Fatal(err)
			}
			opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, versions, "up"), hooksForDirection("up")
			if err := runMigrations(ctx, pool, opts); err != nil {
				t.Fatal(err)
			}
		})
	}
}
