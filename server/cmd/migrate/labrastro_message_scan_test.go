package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"testing"
	"time"
)

func TestMessageScanMigrationsRoundTrip(t *testing.T) {
	for _, populated := range []bool{false, true} {
		name := "empty"
		if populated {
			name = "populated"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			admin := openTestPool(t)
			schema := createScratchSchema(t, ctx, admin, "message_scan_")
			pool := openTestPoolWithSearchPath(t, schema)
			exec := func(sql string) {
				t.Helper()
				if _, err := pool.Exec(ctx, sql); err != nil {
					t.Fatal(err)
				}
			}
			// Only the indexed columns are needed; the real migrations below
			// must work with both an empty table and historical source rows.
			exec(`CREATE TABLE labrastro_message_delivery(run_id uuid, installation_id uuid, target_key text, status text, lease_expires_at timestamptz);
				CREATE TABLE inbox_item(id uuid, created_at timestamptz, recipient_type text);
				CREATE TABLE activity_log(id uuid, created_at timestamptz, action text);
				CREATE TABLE comment(id uuid, created_at timestamptz, type text, deleted_at timestamptz)`)
			opts := runOptions{SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1}
			run := func(direction string, stems []string) {
				t.Helper()
				o := opts
				o.Direction, o.Files, o.Hooks = direction, realMigrationFiles(t, stems, direction), hooksForDirection(direction)
				if err := runMigrations(ctx, pool, o); err != nil {
					t.Fatal(err)
				}
			}
			run("up", []string{"461_labrastro_message_scan_cursor"})
			exec(`ALTER TABLE labrastro_message_scan_cursor ADD COLUMN cycle_upper_id uuid`)
			if populated {
				exec(`INSERT INTO labrastro_message_delivery SELECT CASE WHEN n%2=0 THEN gen_random_uuid() END,gen_random_uuid(),'group:test',CASE WHEN n%3=0 THEN 'sending' ELSE 'sent' END,CASE WHEN n%5=0 THEN NULL ELSE now() END FROM generate_series(1,1000) n;
					INSERT INTO inbox_item SELECT gen_random_uuid(),now(),CASE WHEN n%2=0 THEN 'member' ELSE 'agent' END FROM generate_series(1,1000) n;
					INSERT INTO activity_log SELECT gen_random_uuid(),now(),CASE WHEN n%2=0 THEN 'status_changed' ELSE 'created' END FROM generate_series(1,1000) n;
					INSERT INTO comment SELECT gen_random_uuid(),now(),'comment',CASE WHEN n%2=0 THEN now() END FROM generate_series(1,1000) n;
					INSERT INTO labrastro_message_scan_cursor(scanner,cursor_ts,cursor_id,cycle_upper_id,generation)
					SELECT scanner,now(),gen_random_uuid(),gen_random_uuid(),7 FROM unnest(ARRAY['comment_source_delivery','run_only_terminal_task']) scanner`)
			}
			stems := []string{
				"9010_labrastro_message_delivery_run_index", "9011_labrastro_message_delivery_sending_index",
				"9012_labrastro_message_inbox_scan_index", "9013_labrastro_message_activity_scan_index",
				"9014_labrastro_message_comment_scan_index", "9015_labrastro_message_source_watermark",
			}
			for range 2 {
				run("up", stems)
				var valid int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname LIKE 'idx_labrastro_message_%' AND i.indisvalid AND i.indpred IS NOT NULL`, schema).Scan(&valid); err != nil || valid != 5 {
					t.Fatalf("valid partial indexes=%d, error=%v", valid, err)
				}
				if populated {
					var reset, retained bool
					if err := pool.QueryRow(ctx, `SELECT cursor_ts='epoch' AND cycle_upper_id IS NULL AND cycle_stable_at IS NULL FROM labrastro_message_scan_cursor WHERE scanner='comment_source_delivery'`).Scan(&reset); err != nil || !reset {
						t.Fatalf("source cursor not reset: %v", err)
					}
					if err := pool.QueryRow(ctx, `SELECT generation=7 AND cycle_upper_id IS NOT NULL FROM labrastro_message_scan_cursor WHERE scanner='run_only_terminal_task'`).Scan(&retained); err != nil || !retained {
						t.Fatalf("run cursor changed: %v", err)
					}
				}
				down := slices.Clone(stems)
				slices.Reverse(down)
				run("down", down)
				var indexes int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname LIKE 'idx_labrastro_message_%'`, schema).Scan(&indexes); err != nil || indexes != 0 {
					t.Fatalf("indexes remain after down: %d, %v", indexes, err)
				}
			}
		})
	}
}
