package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"testing"
)

func TestLabrastroTipChatMigrationsRoundTrip(t *testing.T) {
	ctx := context.Background()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "migrate_tip_chat")
	pool := openTestPoolWithSearchPath(t, schema)
	stems := []string{"9024_labrastro_tip_chat", "9025_labrastro_tip_chat_identity_index", "9026_labrastro_tip_chat_session_index"}
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
			for _, name := range []string{"identity", "session"} {
				assertIndexValidity(t, pool, schema, "idx_labrastro_tip_chat_"+name, true)
			}
		}
	}
}
