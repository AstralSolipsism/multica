package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestV061ConcurrentIndexesRecoverAfterInterruption(t *testing.T) {
	admin := openTestPool(t)
	ctx := context.Background()
	schema := createScratchSchema(t, ctx, admin, "v061_indexes")
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `
		CREATE TABLE agent_task_queue (
		 id uuid DEFAULT gen_random_uuid(), agent_id uuid DEFAULT gen_random_uuid(),
		 created_at timestamptz DEFAULT now(), escalation_for_task_id uuid,
		 started_at timestamptz, status text DEFAULT 'queued');
		CREATE TABLE issue_wakeup (
		 id uuid DEFAULT gen_random_uuid(), issue_id uuid DEFAULT gen_random_uuid(),
		 expires_at timestamptz DEFAULT now(), enabled boolean DEFAULT true, system_rule text DEFAULT 'child_done');
		CREATE TABLE issue_child_event (
		 id uuid DEFAULT gen_random_uuid(), parent_id uuid DEFAULT gen_random_uuid(),
		 created_at timestamptz DEFAULT now(), processed_at timestamptz);
		CREATE TABLE search_index_change (
		 entity_type text DEFAULT 'issue', entity_id uuid DEFAULT gen_random_uuid(),
		 workspace_id uuid DEFAULT gen_random_uuid(), change_xid xid8 DEFAULT pg_current_xact_id(),
		 changed_at timestamptz DEFAULT now());
	`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ version, table string }{
		{"552_agent_task_history_page_index", "agent_task_queue"},
		{"554_wakeup_expiry_index", "issue_wakeup"},
		{"556_wakeup_system_rule_index", "issue_wakeup"},
		{"559_issue_child_event_id", "issue_child_event"},
		{"560_issue_child_event_pending", "issue_child_event"},
		{"562_search_index_change_workspace_index", "search_index_change"},
		{"563_search_index_change_changed_at_index", "search_index_change"},
	} {
		t.Run(tc.version, func(t *testing.T) {
			path := filepath.Join("../../migrations", tc.version+".up.sql")
			ddl, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			holder, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(ctx)
			if _, err := holder.Exec(ctx, "INSERT INTO "+tc.table+" DEFAULT VALUES"); err != nil {
				t.Fatal(err)
			}
			builder, err := pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer builder.Release()
			if _, err := builder.Exec(ctx, "SET statement_timeout = '200ms'"); err != nil {
				t.Fatal(err)
			}
			_, err = builder.Exec(ctx, string(ddl))
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "57014" {
				t.Fatalf("expected interrupted build, got %v", err)
			}
			if _, err := builder.Exec(ctx, "RESET statement_timeout"); err != nil {
				t.Fatal(err)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			index := concurrentIndexCleanups[tc.version]
			if index == "" || preMigrationHooks[tc.version] == nil {
				t.Fatal("missing production invalid-index cleanup")
			}
			assertIndexValidity(t, pool, schema, index, false)
			opts := runOptions{Direction: "up", Files: []string{path}, Hooks: preMigrationHooks,
				SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: migrationAdvisoryLockKey}
			if err := runMigrations(ctx, pool, opts); err != nil {
				t.Fatal(err)
			}
			assertIndexReadyAndValid(t, pool, schema, index, true)
			// The SQL committed but the ledger write was lost: preserve the valid
			// index and record the full migration stem on replay.
			if _, err := pool.Exec(ctx, "DELETE FROM schema_migrations WHERE version=$1", tc.version); err != nil {
				t.Fatal(err)
			}
			if err := runMigrations(ctx, pool, opts); err != nil {
				t.Fatal(err)
			}
			assertIndexReadyAndValid(t, pool, schema, index, true)
		})
	}
}

func TestV061SearchTriggerMigrationBoundsLockWait(t *testing.T) {
	admin := openTestPool(t)
	ctx := context.Background()
	schema := createScratchSchema(t, ctx, admin, "v061_search")
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `
		CREATE TABLE issue (id uuid, workspace_id uuid);
		CREATE TABLE comment (id uuid, workspace_id uuid, content text, deleted_at timestamptz, issue_id uuid, created_at timestamptz);
		CREATE TABLE project (id uuid, workspace_id uuid);
	`); err != nil {
		t.Fatal(err)
	}
	const version = "561_search_index_change"
	path := filepath.Join("../../migrations", version+".up.sql")
	ddl, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ddl), "SET LOCAL statement_timeout = '10s'") {
		t.Fatal("search DDL must bound each statement to 10 seconds")
	}
	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err := holder.Exec(ctx, "INSERT INTO issue VALUES (gen_random_uuid(),gen_random_uuid())"); err != nil {
		t.Fatal(err)
	}
	opts := runOptions{Direction: "up", Files: []string{path}, SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: migrationAdvisoryLockKey}
	started := time.Now()
	err = runMigrations(ctx, pool, opts)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" || time.Since(started) > 8*time.Second {
		t.Fatalf("expected bounded lock timeout, got %v after %s", err, time.Since(started))
	}
	var recorded bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", version).Scan(&recorded); err != nil || recorded {
		t.Fatalf("failed migration was recorded: %v, %v", recorded, err)
	}
	var partial bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('search_index_change') IS NOT NULL").Scan(&partial); err != nil || partial {
		t.Fatalf("failed DDL left partial objects: %v, %v", partial, err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// A scoped DDL hook makes a CREATE TRIGGER statement exceed its own
	// budget, independently of lock waiting. Other test schemas are untouched.
	// Event triggers require the same superuser fixture used by migration tests.
	var superuser bool
	if err := pool.QueryRow(ctx, "SELECT rolsuper FROM pg_roles WHERE rolname=current_user").Scan(&superuser); err != nil {
		t.Fatal(err)
	}
	if superuser {
		trigger := "slow_" + schema
		if _, err := pool.Exec(ctx, "CREATE FUNCTION slow_search_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF current_schema() = '"+schema+"' THEN PERFORM pg_sleep(11); END IF; END $$"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, "CREATE EVENT TRIGGER "+trigger+" ON ddl_command_start WHEN TAG IN ('CREATE TRIGGER') EXECUTE FUNCTION slow_search_ddl()"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP EVENT TRIGGER IF EXISTS "+trigger) })
		started = time.Now()
		err = runMigrations(ctx, pool, opts)
		if !errors.As(err, &pgErr) || pgErr.Code != "57014" || time.Since(started) > 15*time.Second {
			t.Fatalf("expected 10s statement timeout, got %v after %s", err, time.Since(started))
		}
		if _, err := pool.Exec(ctx, "DROP EVENT TRIGGER "+trigger); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, "SELECT to_regclass('search_index_change') IS NOT NULL").Scan(&partial); err != nil || partial {
			t.Fatalf("statement timeout left partial objects: %v, %v", partial, err)
		}
	} else {
		t.Log("statement timeout fault injection requires a superuser; configured 10s bound checked statically")
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO issue VALUES (gen_random_uuid(),gen_random_uuid())"); err != nil {
		t.Fatal(err)
	}
	var changes int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM search_index_change").Scan(&changes); err != nil || changes != 1 {
		t.Fatalf("recovered trigger recorded %d changes: %v", changes, err)
	}
}
