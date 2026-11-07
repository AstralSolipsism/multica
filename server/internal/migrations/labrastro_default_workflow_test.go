package migrations

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestLabrastroDefaultWorkflowRepair(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable DATABASE_URL")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
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
	schema := fmt.Sprintf("default_repair_%d", time.Now().UnixNano())
	exec("CREATE SCHEMA " + schema)
	exec("SET LOCAL search_path TO " + schema + ", public")
	exec(`CREATE TABLE issue_workflow (id int, workspace_id int, is_default bool, steps jsonb, updated_at timestamptz);
		CREATE TABLE issue_status (workspace_id int, key text, is_system bool, archived_at timestamptz, position float8);
		CREATE TABLE issue (workspace_id int, status text, project_id int);
		CREATE TABLE project (id int, workspace_id int, workflow_id int);
		INSERT INTO issue_workflow VALUES
		(1,1,true,'[{"status_key":"todo","handler":{"type":"none"}},{"status_key":"blocked"},{"status_key":"done"},{"status_key":"cancelled"}]',now()),
		(2,1,false,'[{"status_key":"backlog_2"},{"status_key":"done_2"},{"status_key":"named_only"},{"status_key":"deleted_only"},{"status_key":"other_workspace"}]',now()),
		(3,2,true,'[]',now());
		INSERT INTO issue_status VALUES
		(1,'loose',false,null,30),(1,'backlog_2',false,null,10),(1,'done_2',false,null,20),
		(1,'named_only',false,null,40),(1,'archived',false,now(),50),(1,'todo',true,null,0),
		(1,'deleted_only',false,null,60),(1,'other_workspace',false,null,70),(2,'own',false,null,10);
		INSERT INTO project VALUES (10,1,null),(11,1,2),(12,2,null);
		INSERT INTO issue VALUES (1,'backlog_2',null),(1,'done_2',10),(1,'named_only',11),
		(1,'deleted_only',null),(1,'archived',null),(1,'other_workspace',12);
		DELETE FROM issue WHERE status='deleted_only';`)
	read := func(id int) []string {
		t.Helper()
		var keys []string
		if err := tx.QueryRow(ctx, `SELECT array_agg(value->>'status_key' ORDER BY ord)
			FROM issue_workflow, jsonb_array_elements(steps) WITH ORDINALITY AS step(value,ord) WHERE id=$1`, id).Scan(&keys); err != nil {
			t.Fatal(err)
		}
		return keys
	}
	named := read(2)
	for i := 0; i < 2; i++ {
		exec(readMigrationFile(t, "9054_labrastro_default_workflow_keep_in_use_statuses.up.sql"))
		want := []string{"todo", "backlog_2", "done_2", "loose", "blocked", "done", "cancelled"}
		if got := read(1); !reflect.DeepEqual(got, want) {
			t.Fatalf("run %d: %v, want %v", i, got, want)
		}
		if got := read(2); !reflect.DeepEqual(got, named) {
			t.Fatalf("named workflow changed: %v", got)
		}
		if got := read(3); !reflect.DeepEqual(got, []string{"own"}) {
			t.Fatalf("empty Default/workspace isolation: %v", got)
		}
	}
	exec(readMigrationFile(t, "9054_labrastro_default_workflow_keep_in_use_statuses.down.sql"))
	if got := read(1); len(got) != 7 {
		t.Fatalf("rollback removed repaired steps: %v", got)
	}
}
