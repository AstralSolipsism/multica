package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"testing"
)

func TestLabrastroYSKMigrationsRoundTrip(t *testing.T) {
	ctx := context.Background()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "migrate_ysk")
	pool := openTestPoolWithSearchPath(t, schema)
	stems := []string{
		"9016_labrastro_ysk", "9017_labrastro_ysk_tip_id_index", "9018_labrastro_ysk_tip_issue_index",
		"9019_labrastro_ysk_tip_anchor_index", "9020_labrastro_ysk_tip_report_index",
		"9021_labrastro_ysk_state_identity_index", "9022_labrastro_ysk_state_user_index", "9023_labrastro_ysk_topic_identity_index",
	}
	options := runOptions{SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1}
	for _, direction := range []string{"up", "down", "up"} {
		versions := slices.Clone(stems)
		if direction == "down" {
			slices.Reverse(versions)
		}
		options.Direction = direction
		options.Files = realMigrationFiles(t, versions, direction)
		options.Hooks = hooksForDirection(direction)
		if err := runMigrations(ctx, pool, options); err != nil {
			t.Fatalf("%s: %v", direction, err)
		}
		for _, stem := range stems {
			assertMigrationVersionRecorded(t, ctx, pool, schema, stem, direction == "up")
		}
		if direction == "up" {
			for _, name := range []string{"tip_id", "tip_issue", "tip_anchor", "tip_report", "state_identity", "state_user", "topic_identity"} {
				assertIndexValidity(t, pool, schema, "idx_labrastro_ysk_"+name, true)
			}
		}
	}
}
