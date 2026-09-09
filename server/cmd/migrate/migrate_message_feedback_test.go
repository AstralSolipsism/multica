package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestMessageFeedbackPopulatedUpgradeRollbackAndIndexRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "migrate_feedback_")
	pool := openTestPoolWithSearchPath(t, schema)
	opts := runOptions{SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1}
	run := func(direction string, versions []string) error {
		o := opts
		o.Direction, o.Files, o.Hooks = direction, realMigrationFiles(t, versions, direction), hooksForDirection(direction)
		return runMigrations(ctx, pool, o)
	}
	exec := func(sql string) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	count := func(sql string, want int) {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Fatalf("count %d want %d: %s", n, want, sql)
		}
	}
	base := []string{"452_labrastro_message_tables", "453_labrastro_message_route_identity_index", "454_labrastro_message_delivery_dedup_index", "455_labrastro_message_delivery_queue_index", "456_labrastro_message_delivery_listing_index", "457_labrastro_message_receipt_shard_index", "458_labrastro_message_receipt_external_index", "459_labrastro_message_approved_target", "460_labrastro_message_approved_target_active_index", "461_labrastro_message_scan_cursor", "463_labrastro_message_repair_state", "467_labrastro_message_sources", "468_labrastro_message_route_source_identity_index", "469_labrastro_message_delivery_source_index", "470_labrastro_message_approved_target_source_active_index", "471_labrastro_message_source_scope", "472_labrastro_message_drop_preview_approval_index", "473_labrastro_message_project_approval_index"}
	if err := run("up", base); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO labrastro_message_delivery(id,workspace_id,autopilot_id,installation_id,dedup_key,source_kind,source_scope,status,content_snapshot,target_snapshot,target_key)
 SELECT gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'old-'||kind,kind,'run','sent','{"text":"historical result"}','{}','group:oc_old' FROM unnest(ARRAY['run_only','create_issue','test_send']) kind`)
	exec(`INSERT INTO labrastro_message_receipt(delivery_id,workspace_id,installation_id,shard_index,shard_total,send_uuid,external_message_id)
 SELECT id,workspace_id,installation_id,0,1,id::text,'om_'||id::text FROM labrastro_message_delivery`)
	versions := []string{"474_labrastro_message_feedback", "475_labrastro_message_feedback_identity_index", "476_labrastro_message_feedback_pending_index", "477_labrastro_message_feedback_comment_index"}
	if err := run("up", versions[:1]); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO labrastro_message_feedback(installation_id,inbound_message_id,workspace_id,delivery_id,quoted_message_id,sender_id,user_id,installation_agent_id,chat_id,content,kind)
 SELECT installation_id,'om_in',workspace_id,id,'om_'||id::text,'ou_member',gen_random_uuid(),gen_random_uuid(),'oc_old','feedback','comment' FROM labrastro_message_delivery WHERE source_kind='run_only'`)
	// A real failed concurrent unique build must leave an invalid index.
	exec(`INSERT INTO labrastro_message_feedback SELECT * FROM labrastro_message_feedback`)
	if err := run("up", versions[1:2]); err == nil {
		t.Fatal("duplicate data did not fail unique build")
	}
	assertIndexValidity(t, pool, schema, "uq_labrastro_message_feedback_identity", false)
	exec(`DELETE FROM labrastro_message_feedback WHERE ctid IN (SELECT ctid FROM labrastro_message_feedback LIMIT 1)`)
	if err := run("up", versions[1:]); err != nil {
		t.Fatalf("invalid-index retry: %v", err)
	}
	assertIndexValidity(t, pool, schema, "uq_labrastro_message_feedback_identity", true)
	count(`SELECT count(*) FROM labrastro_message_feedback`, 1)
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE content_snapshot->>'text'='historical result'`, 3)
	count(`SELECT count(*) FROM labrastro_message_receipt`, 3)
	down := slices.Clone(versions)
	slices.Reverse(down)
	if err := run("down", down); err == nil || !strings.Contains(err.Error(), "retain feedback identities") {
		t.Fatalf("populated downgrade silently lost dedup: %v", err)
	}
	assertIndexValidity(t, pool, schema, "uq_labrastro_message_feedback_identity", true)
	assertIndexValidity(t, pool, schema, "idx_labrastro_message_feedback_comment", true)
	count(`SELECT count(*) FROM labrastro_message_feedback`, 1)
	// Explicit retirement is simulated only in the isolated scratch schema.
	exec(`DELETE FROM labrastro_message_feedback`)
	if err := run("down", down); err != nil {
		t.Fatal(err)
	}
	count(`SELECT count(*) FROM labrastro_message_delivery`, 3)
	count(`SELECT count(*) FROM labrastro_message_receipt`, 3)
	if err := run("up", versions); err != nil {
		t.Fatalf("re-upgrade: %v", err)
	}
	count(`SELECT count(*) FROM labrastro_message_feedback`, 0)
	count(`SELECT count(*) FROM labrastro_message_delivery`, 3)
	count(`SELECT count(*) FROM labrastro_message_receipt`, 3)
}
