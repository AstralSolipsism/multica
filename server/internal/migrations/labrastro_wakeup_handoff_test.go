package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Run the shipped function definitions in both ledger orders. A fresh database
// runs upstream first; an existing fork has already run 9009 when 579 arrives.
func TestLabrastroWakeupHandoffMigrationOrders(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("integration test requires Postgres at DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	for _, order := range []struct {
		name  string
		files []string
	}{
		{"fresh", []string{"579_wakeup_skip_handed_to_agent.up.sql", "9009_labrastro_wakeup_conversation_provenance.up.sql"}},
		{"upgrade", []string{"9009_labrastro_wakeup_conversation_provenance.up.sql", "579_wakeup_skip_handed_to_agent.up.sql"}},
	} {
		t.Run(order.name, func(t *testing.T) {
			tx, err := conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			exec := func(sql string, args ...any) {
				t.Helper()
				if _, err := tx.Exec(ctx, sql, args...); err != nil {
					t.Fatal(err)
				}
			}
			// Keep function replacements and fixtures in a disposable schema,
			// never replace the public capture function used by other suites.
			schema := fmt.Sprintf("capture_handoff_%d", time.Now().UnixNano())
			exec("CREATE SCHEMA " + schema)
			exec("SET LOCAL search_path TO " + schema + ", public")
			exec(`
				CREATE TABLE issue (id uuid, workspace_id uuid, status text);
				CREATE TABLE issue_status (workspace_id uuid, key text, category text);
				CREATE TABLE agent_task_queue (id uuid, conversation_root_task_id uuid, context jsonb);
				CREATE TABLE issue_wakeup (
					id uuid, workspace_id uuid, issue_id uuid, agent_id uuid,
					enabled boolean, kind text, event_types text[], revision bigint,
					filter_actor_type text, filter_actor_id uuid, filter_agent_id uuid,
					filter_task_id uuid, source_task_id uuid
				);
				CREATE TABLE issue_wakeup_receipt (
					id uuid, wakeup_id uuid, revision bigint, event_key text,
					event_type text, payload jsonb, coalesce_key text, processed_at timestamptz
				);
				CREATE UNIQUE INDEX issue_wakeup_receipt_key_idx
					ON issue_wakeup_receipt(wakeup_id, revision, event_key);
				CREATE UNIQUE INDEX pending_receipt
					ON issue_wakeup_receipt(wakeup_id, revision, coalesce_key)
					WHERE processed_at IS NULL AND coalesce_key IS NOT NULL;
			`)
			for _, file := range order.files {
				exec(readMigrationFile(t, file))
			}
			exec(readMigrationFile(t, "9028_labrastro_wakeup_skip_handed_to_agent.up.sql"))

			const issue = "00000000-0000-0000-0000-000000000001"
			const workspace = "00000000-0000-0000-0000-000000000002"
			const target = "00000000-0000-0000-0000-000000000003"
			const observer = "00000000-0000-0000-0000-000000000004"
			const source = "00000000-0000-0000-0000-000000000005"
			const root = "00000000-0000-0000-0000-000000000006"
			const otherRoot = "00000000-0000-0000-0000-000000000007"
			exec("INSERT INTO issue VALUES ($1,$2,'in_progress')", issue, workspace)
			exec("INSERT INTO agent_task_queue VALUES ($1,$2,'{}')", source, root)
			for _, agent := range []any{target, observer, nil} {
				exec(`INSERT INTO issue_wakeup (id, workspace_id, issue_id, agent_id, enabled, kind, event_types, revision)
					VALUES (gen_random_uuid(),$1,$2,$3,true,'event',ARRAY['issue.updated','comment.created'],1)`,
					workspace, issue, agent)
			}
			exec("SELECT set_config('multica.handed_to_agent',$1,true)", target)
			capture := func(kind, key string, task any) {
				t.Helper()
				exec("SELECT capture_issue_wakeup($1,$2,$3,NULL,$4,'{}')", issue, kind, key, task)
			}
			count := func(kind string, want int) {
				t.Helper()
				var n int
				if err := tx.QueryRow(ctx, "SELECT count(*) FROM issue_wakeup_receipt WHERE event_type=$1", kind).Scan(&n); err != nil {
					t.Fatal(err)
				}
				if n != want {
					t.Fatalf("%s receipts = %d, want %d", kind, n, want)
				}
			}
			capture("issue.updated", "handoff", source)
			count("issue.updated", 2) // Other agents and system rules still receive it.
			var targetReceipts int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM issue_wakeup_receipt r
				JOIN issue_wakeup w ON w.id=r.wakeup_id WHERE w.agent_id=$1`, target).Scan(&targetReceipts); err != nil {
				t.Fatal(err)
			}
			if targetReceipts != 0 {
				t.Fatal("the handed-to agent received a duplicate issue wakeup")
			}
			capture("comment.created", "external", source)
			count("comment.created", 3) // Handoff suppression applies only to issue.*.
			capture("comment.created", "first-party", nil)
			assertProvenance := func(wantConflict bool) {
				t.Helper()
				var valid int
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM issue_wakeup_receipt
					WHERE event_type='comment.created' AND payload->>'conversation_root_task_id'=$1
					AND COALESCE((payload->>'conversation_roots_conflict')::boolean,false)=$2`,
					root, wantConflict).Scan(&valid); err != nil {
					t.Fatal(err)
				}
				if valid != 3 {
					t.Fatalf("preserved root/conflict=%t in %d of 3 receipts", wantConflict, valid)
				}
			}
			assertProvenance(false)
			exec("UPDATE agent_task_queue SET conversation_root_task_id=$1 WHERE id=$2", otherRoot, source)
			capture("comment.created", "conflicting-root", source)
			assertProvenance(true)

			exec(readMigrationFile(t, "9028_labrastro_wakeup_skip_handed_to_agent.down.sql"))
			capture("issue.updated", "after-rollback", source)
			count("issue.updated", 3)
			capture("comment.created", "rollback-first-party", nil)
			assertProvenance(true)
		})
	}
}
