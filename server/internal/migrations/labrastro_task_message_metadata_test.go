package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestLabrastroTaskMessageMetadataMigrationOrders(t *testing.T) {
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
	const up = "9029_labrastro_task_message_metadata.up.sql"
	const down = "9029_labrastro_task_message_metadata.down.sql"
	for _, order := range []struct {
		name  string
		files []string
	}{
		{"fresh", []string{"457_task_message_output_truncated.up.sql", "500_task_message_call_id.up.sql", up}},
		{"upgrade", []string{up, "457_task_message_output_truncated.up.sql", "500_task_message_call_id.up.sql"}},
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
			schema := fmt.Sprintf("message_metadata_%d", time.Now().UnixNano())
			exec("CREATE SCHEMA " + schema)
			exec("SET LOCAL search_path TO " + schema + ", public")
			exec("CREATE TABLE agent_task_queue (id uuid PRIMARY KEY)")
			exec(readMigrationFile(t, "026_task_messages.up.sql"))
			const taskID = "00000000-0000-0000-0000-000000000001"
			exec("INSERT INTO agent_task_queue (id) VALUES ($1)", taskID)
			exec("INSERT INTO task_message (task_id,seq,type,content) VALUES ($1,1,'thinking','old')", taskID)
			for _, file := range order.files {
				exec(readMigrationFile(t, file))
			}
			var nullable, dataType string
			var defaultValue *string
			if err := tx.QueryRow(ctx, `SELECT is_nullable, data_type, column_default
    FROM information_schema.columns WHERE table_schema=$1 AND table_name='task_message' AND column_name='metadata'`, schema).
				Scan(&nullable, &dataType, &defaultValue); err != nil {
				t.Fatal(err)
			}
			if nullable != "YES" || dataType != "jsonb" || defaultValue != nil {
				t.Fatalf("column = %s/%s/%v, want nullable JSONB without default", nullable, dataType, defaultValue)
			}
			var oldNull bool
			if err := tx.QueryRow(ctx, "SELECT metadata IS NULL FROM task_message WHERE seq=1").Scan(&oldNull); err != nil {
				t.Fatal(err)
			}
			if !oldNull {
				t.Fatal("historical row was backfilled")
			}
			exec(`INSERT INTO task_message(task_id,seq,type,metadata) VALUES ($1,2,'text','{"future":true}')`, taskID)
			exec(readMigrationFile(t, down))
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='task_message' AND column_name='metadata'`, schema).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatal("metadata survived down migration")
			}
			if err := tx.QueryRow(ctx, "SELECT count(*) FROM task_message").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 2 {
				t.Fatal("rollback lost transcript rows")
			}
			exec(readMigrationFile(t, up))
			if err := tx.QueryRow(ctx, "SELECT count(*) FROM task_message WHERE metadata IS NULL").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 2 {
				t.Fatal("reapplying migration did not leave metadata NULL")
			}
		})
	}
}
