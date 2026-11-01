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
		"9046_labrastro_engineering_decision_credentials",
	}

	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions[:1], "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_engineering (workspace_id,project_id,updated_by_type,updated_by_id)
SELECT '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','member',gen_random_uuid() FROM generate_series(1,2)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO project_baseline_revision
(workspace_id, project_id, chapter, revision_number, status, content_markdown, change_summary, anchors_diff, created_by_type, created_by_id, decision_credential)
SELECT '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'overview', n,
'adopted', 'historical content', 'historical summary', '{}', 'member', '00000000-0000-0000-0000-000000000003', credential
FROM unnest(ARRAY['session', 'pat', 'task', NULL]) WITH ORDINALITY AS credentials(credential, n)`); err != nil {
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
	assertCredentials := func(agentCredential string, hasSwitch bool) {
		t.Helper()
		var credentials string
		if err := pool.QueryRow(ctx, `SELECT string_agg(COALESCE(decision_credential, 'null'), ',' ORDER BY revision_number)
FROM project_baseline_revision WHERE content_markdown='historical content' AND change_summary='historical summary'
AND created_by_id='00000000-0000-0000-0000-000000000003'`).Scan(&credentials); err != nil {
			t.Fatal(err)
		}
		if credentials != "session,pat,"+agentCredential+",null" {
			t.Fatalf("migration changed history: %s", credentials)
		}
		var switchExists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
WHERE table_schema=$1 AND table_name='project_engineering' AND column_name='agent_decisions_enabled')`, schema).Scan(&switchExists); err != nil {
			t.Fatal(err)
		}
		if switchExists != hasSwitch {
			t.Fatalf("switch exists=%v, want %v", switchExists, hasSwitch)
		}
		if hasSwitch {
			var enabled bool
			if err := pool.QueryRow(ctx, `SELECT agent_decisions_enabled FROM project_engineering`).Scan(&enabled); err != nil || enabled {
				t.Fatalf("restored switch must default to false: %v, %v", enabled, err)
			}
		}
		other := "task"
		if agentCredential == "task" {
			other = "agent_task"
		}
		for _, invalid := range []string{other, "future"} {
			if _, err := pool.Exec(ctx, `UPDATE project_baseline_revision SET decision_credential=$1 WHERE revision_number=3`, invalid); err == nil {
				t.Fatalf("CHECK accepted invalid credential %s", invalid)
			}
		}
	}
	assertCredentials("agent_task", false)
	// Verify a deployed v3.1 database can upgrade, roll back and upgrade again.
	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, versions[len(versions)-1:], "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertCredentials("task", true)
	opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, versions, "up"), hooksForDirection("up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertCredentials("agent_task", false)

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
