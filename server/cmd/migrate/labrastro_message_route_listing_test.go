package main

import (
	"context"
	"math/rand/v2"
	"testing"
	"time"
)

func TestMessageRouteListingMigrationRoundTrip(t *testing.T) {
	for _, populated := range []bool{false, true} {
		name := "fresh"
		if populated {
			name = "populated"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			admin := openTestPool(t)
			schema := createScratchSchema(t, ctx, admin, "message_route_listing_")
			pool := openTestPoolWithSearchPath(t, schema)
			if _, err := pool.Exec(ctx, `CREATE TABLE labrastro_message_delivery (
				id uuid PRIMARY KEY, workspace_id uuid, route_id uuid, created_at timestamptz)`); err != nil {
				t.Fatal(err)
			}
			wantRows := 0
			if populated {
				wantRows = 1000
				if _, err := pool.Exec(ctx, `INSERT INTO labrastro_message_delivery
					SELECT gen_random_uuid(), gen_random_uuid(),
					CASE WHEN n%2=0 THEN gen_random_uuid() END, now()
					FROM generate_series(1,1000) n`); err != nil {
					t.Fatal(err)
				}
			}
			stems := []string{"9065_labrastro_message_delivery_route_listing_index"}
			opts := runOptions{SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1}
			for _, direction := range []string{"up", "down", "up"} {
				o := opts
				o.Direction, o.Files, o.Hooks = direction, realMigrationFiles(t, stems, direction), hooksForDirection(direction)
				if err := runMigrations(ctx, pool, o); err != nil {
					t.Fatal(err)
				}
				var valid bool
				if err := pool.QueryRow(ctx, `SELECT EXISTS (
					SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
					JOIN pg_namespace n ON n.oid=c.relnamespace
					WHERE n.nspname=$1 AND c.relname='idx_labrastro_message_delivery_route_listing'
					AND i.indisvalid AND i.indpred IS NOT NULL)`, schema).Scan(&valid); err != nil || valid != (direction == "up") {
					t.Fatalf("%s: valid partial index=%v err=%v", direction, valid, err)
				}
				var rows int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM labrastro_message_delivery`).Scan(&rows); err != nil || rows != wantRows {
					t.Fatalf("%s changed history: rows=%d want=%d err=%v", direction, rows, wantRows, err)
				}
			}
		})
	}
}
