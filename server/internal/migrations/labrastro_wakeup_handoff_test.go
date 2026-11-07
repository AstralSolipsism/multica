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
// runs upstream 579 before the fork variants; an existing fork had already run
// 9009 when 579 arrived. Either way 9066 must leave upstream 579's behavior,
// and its down/up must restore and then remove conversation provenance again.
func TestLabrastroWakeupCaptureMigrationOrders(t *testing.T) {
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
			// never replace the public functions used by other suites.
			schema := fmt.Sprintf("capture_handoff_%d", time.Now().UnixNano())
			exec("CREATE SCHEMA " + schema)
			exec("SET LOCAL search_path TO " + schema + ", public")
			exec(`
				CREATE TABLE issue (id uuid, workspace_id uuid, status text);
				CREATE TABLE issue_status (workspace_id uuid, key text, category text);
				CREATE TABLE agent_task_queue (
					id uuid, conversation_root_task_id uuid, context jsonb,
					originator_source text, retry_of_task_id uuid, delegated_from_task_id uuid
				);
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
			exec(readMigrationFile(t, "9066_labrastro_retire_conversation_provenance.up.sql"))

			const issue = "00000000-0000-0000-0000-000000000001"
			const workspace = "00000000-0000-0000-0000-000000000002"
			const target = "00000000-0000-0000-0000-000000000003"
			const observer = "00000000-0000-0000-0000-000000000004"
			const source = "00000000-0000-0000-0000-000000000005"
			const root = "00000000-0000-0000-0000-000000000006"
			exec("INSERT INTO issue VALUES ($1,$2,'in_progress')", issue, workspace)
			exec("INSERT INTO agent_task_queue (id, conversation_root_task_id, context) VALUES ($1,$2,'{}')", source, root)
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
			count := func(sql string, args ...any) int {
				t.Helper()
				var n int
				if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
					t.Fatal(err)
				}
				return n
			}
			rooted := func() int {
				t.Helper()
				return count(`SELECT count(*) FROM issue_wakeup_receipt
					WHERE payload ? 'conversation_root_task_id' OR payload ? 'conversation_roots_conflict'`)
			}

			capture("issue.updated", "handoff", source)
			if n := count("SELECT count(*) FROM issue_wakeup_receipt WHERE event_type='issue.updated'"); n != 2 {
				t.Fatalf("issue.updated receipts = %d, want 2 (other agents and system rules)", n)
			}
			if n := count(`SELECT count(*) FROM issue_wakeup_receipt r JOIN issue_wakeup w ON w.id=r.wakeup_id
				WHERE w.agent_id=$1`, target); n != 0 {
				t.Fatal("the handed-to agent received a duplicate issue wakeup")
			}
			capture("comment.created", "external", source)
			if n := count("SELECT count(*) FROM issue_wakeup_receipt WHERE event_type='comment.created'"); n != 3 {
				t.Fatalf("comment.created receipts = %d, want 3 (handoff suppression is issue.* only)", n)
			}
			if n := rooted(); n != 0 {
				t.Fatalf("%d receipts still carry conversation provenance after 9066", n)
			}

			exec(readMigrationFile(t, "9066_labrastro_retire_conversation_provenance.down.sql"))
			capture("comment.created", "after-down", source)
			if n := count(`SELECT count(*) FROM issue_wakeup_receipt WHERE event_type='comment.created'
				AND payload->>'conversation_root_task_id'=$1`, root); n != 3 {
				t.Fatalf("9066 down restored provenance on %d of 3 receipts", n)
			}
			const child = "00000000-0000-0000-0000-000000000008"
			exec(`INSERT INTO agent_task_queue (id, context, originator_source, delegated_from_task_id)
				VALUES ($1,'{}','delegation',$2)`, child, source)
			if n := count("SELECT count(*) FROM agent_task_queue WHERE id=$1 AND conversation_root_task_id=$2", child, root); n != 1 {
				t.Fatal("9066 down did not restore root stamping on new tasks")
			}

			exec(readMigrationFile(t, "9066_labrastro_retire_conversation_provenance.up.sql"))
			exec("DELETE FROM issue_wakeup_receipt")
			capture("comment.created", "after-up-again", source)
			if n := rooted(); n != 0 {
				t.Fatal("9066 up after down kept conversation provenance")
			}
			const grandchild = "00000000-0000-0000-0000-000000000009"
			exec(`INSERT INTO agent_task_queue (id, context, originator_source, delegated_from_task_id)
				VALUES ($1,'{}','delegation',$2)`, grandchild, child)
			if n := count("SELECT count(*) FROM agent_task_queue WHERE id=$1 AND conversation_root_task_id IS NULL", grandchild); n != 1 {
				t.Fatal("9066 up after down still stamps conversation roots")
			}
		})
	}
}
