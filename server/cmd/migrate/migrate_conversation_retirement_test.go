package main

import (
	"context"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
)

func TestConversationRetirementPreservesHistoryAndRefusesDowngrade(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "conversation_retirement_")
	pool := openTestPoolWithSearchPath(t, schema)
	options := runOptions{SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1}
	run := func(direction, version string) error {
		opts := options
		opts.Direction = direction
		opts.Files = realMigrationFiles(t, []string{version}, direction)
		return runMigrations(ctx, pool, opts)
	}
	if err := run("up", "474_labrastro_message_feedback"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO labrastro_message_feedback
	(installation_id,inbound_message_id,workspace_id,delivery_id,quoted_message_id,sender_id,user_id,installation_agent_id,chat_id,content,kind,status,comment_id,chat_session_id)
	SELECT gen_random_uuid(),state,gen_random_uuid(),gen_random_uuid(),'om_quote','ou_external',gen_random_uuid(),gen_random_uuid(),'oc_chat','original text','comment',state,gen_random_uuid(),gen_random_uuid()
	FROM unnest(ARRAY['pending','complete','rejected']) state`); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT json_agg(ROW(inbound_message_id,content,comment_id,chat_session_id) ORDER BY inbound_message_id)::text FROM labrastro_message_feedback`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := run("up", "478_labrastro_feedback_retirement"); err != nil {
		t.Fatal(err)
	}
	var after string
	var active int
	if err := pool.QueryRow(ctx, `SELECT json_agg(ROW(inbound_message_id,content,comment_id,chat_session_id) ORDER BY inbound_message_id)::text FROM labrastro_message_feedback`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("retirement changed historical text or comment/run associations")
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM labrastro_message_feedback WHERE status='pending' OR acknowledged_at IS NULL`).Scan(&active); err != nil || active != 0 {
		t.Fatalf("old recovery still has work: %d/%v", active, err)
	}
	if err := run("down", "478_labrastro_feedback_retirement"); err == nil || !strings.Contains(err.Error(), "cannot be undone") {
		t.Fatalf("unsafe downgrade: %v", err)
	}
	if err := run("up", "478_labrastro_feedback_retirement"); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
}
