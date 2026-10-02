package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// This opt-in fixture allocates a production-shaped history table in a private
// scratch schema. It never edits public history or relaxes migration timeouts.
// Run with LABRASTRO_TEST_WAKEUP_HISTORY_ROWS=2000000 and -run LargeHistory -v.
func TestWakeupConversationMigrationLargeHistory(t *testing.T) {
	raw := os.Getenv("LABRASTRO_TEST_WAKEUP_HISTORY_ROWS")
	if raw == "" {
		t.Skip("set LABRASTRO_TEST_WAKEUP_HISTORY_ROWS for the large-history rehearsal")
	}
	rows, err := strconv.Atoi(raw)
	if err != nil || rows < 1 {
		t.Fatal("LABRASTRO_TEST_WAKEUP_HISTORY_ROWS must be a positive integer")
	}
	ctx := context.Background()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "wakeup_history")
	pool := openTestPoolWithSearchPath(t, schema)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE TABLE agent_task_queue (LIKE public.agent_task_queue INCLUDING DEFAULTS INCLUDING CONSTRAINTS, PRIMARY KEY(id));
CREATE TABLE issue_wakeup(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_task_id uuid, created_by uuid)`)
	// Ordinary history dominates the table; the backfill should not repeatedly
	// scan it for every link of a small external descendant chain.
	exec(`INSERT INTO agent_task_queue(id,agent_id,runtime_id,status,context)
SELECT md5('history-'||n::text)::uuid,'00000000-0000-4000-8000-000000000001'::uuid,
 '00000000-0000-4000-8000-000000000002'::uuid,'completed',
 jsonb_build_object('history',repeat(md5(n::text),16)) FROM generate_series(1,$1::integer) n`, rows)
	apply := func(stem string) {
		t.Helper()
		if err := runMigrations(ctx, pool, runOptions{Direction: "up",
			Files:                 []string{filepath.Join("../../migrations", stem+".up.sql")},
			SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: migrationAdvisoryLockKey}); err != nil {
			t.Fatal(err)
		}
	}
	apply("551_channel_conversation_root")
	var root pgtype.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO agent_task_queue(agent_id,runtime_id,originator_source,status)
VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','channel_integration','completed') RETURNING id`).Scan(&root); err != nil {
		t.Fatal(err)
	}
	parent := root
	const descendants = 32
	for i := 0; i < descendants; i++ {
		if err := pool.QueryRow(ctx, `INSERT INTO agent_task_queue(agent_id,runtime_id,originator_source,delegated_from_task_id,status)
VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','trigger_owner',$1,'completed') RETURNING id`, parent).Scan(&parent); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO issue_wakeup(source_task_id) VALUES($1)", parent)
	exec("ANALYZE agent_task_queue")
	var bytes int64
	var fsync, syncCommit string
	if err := pool.QueryRow(ctx, "SELECT pg_total_relation_size('agent_task_queue'), current_setting('fsync'), current_setting('synchronous_commit')").Scan(&bytes, &fsync, &syncCommit); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	apply("564_wakeup_conversation_root")
	t.Logf("history_rows=%d descendants=%d table_bytes=%d fsync=%s synchronous_commit=%s migration_elapsed=%s", rows, descendants, bytes, fsync, syncCommit, time.Since(started))
	var rooted, ordinary int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE conversation_root_task_id=$1),
count(*) FILTER(WHERE conversation_root_task_id IS NULL) FROM agent_task_queue`, root).Scan(&rooted, &ordinary); err != nil {
		t.Fatal(err)
	}
	if rooted != descendants+1 || ordinary != rows {
		t.Fatalf("wrong lineage after scale backfill: external=%d ordinary=%d", rooted, ordinary)
	}
	var ruleRoot pgtype.UUID
	if err := pool.QueryRow(ctx, "SELECT conversation_root_task_id FROM issue_wakeup").Scan(&ruleRoot); err != nil || ruleRoot != root {
		t.Fatalf("rule lost root: %v %v", ruleRoot, err)
	}
}
