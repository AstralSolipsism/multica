package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"time"
)

// Exercise real migration files on populated preview data, including test
// sends and receipts. A fresh-schema test alone cannot prove this contract.
func TestMessageSourceScopeUpgradeAndRollback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "migrate_message_scope_")
	pool := openTestPoolWithSearchPath(t, schema)
	opts := runOptions{
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
	}
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
		var got int
		if err := pool.QueryRow(ctx, sql).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("count=%d, want %d: %s", got, want, sql)
		}
	}
	base := []string{
		"452_labrastro_message_tables", "453_labrastro_message_route_identity_index",
		"454_labrastro_message_delivery_dedup_index", "455_labrastro_message_delivery_queue_index",
		"456_labrastro_message_delivery_listing_index", "457_labrastro_message_receipt_shard_index",
		"458_labrastro_message_receipt_external_index", "459_labrastro_message_approved_target",
		"460_labrastro_message_approved_target_active_index", "461_labrastro_message_scan_cursor",
		"463_labrastro_message_repair_state",
	}
	preview := []string{
		"467_labrastro_message_sources", "468_labrastro_message_route_source_identity_index",
		"469_labrastro_message_delivery_source_index", "470_labrastro_message_approved_target_source_active_index",
	}
	if err := run("up", append(base, preview...)); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO labrastro_message_route(id,workspace_id,autopilot_id,installation_id,
		target_type,target_user_id,target_chat_id,target_key,source_kind,project_id,created_by,updated_by)
		SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
			CASE WHEN scope='run' THEN '00000000-0000-0000-0000-000000000002'::uuid END,
			'00000000-0000-0000-0000-000000000003',
			CASE WHEN scope='inbox' THEN 'member' ELSE 'group' END,
			CASE WHEN scope='inbox' THEN '00000000-0000-0000-0000-000000000004'::uuid END,
			CASE WHEN scope<>'inbox' THEN 'oc_scope' END,
			CASE WHEN scope='inbox' THEN 'member:00000000-0000-0000-0000-000000000004' ELSE 'group:oc_scope' END,
			scope, CASE WHEN scope IN ('activity','comment') THEN gen_random_uuid() END,
			'00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004'
		FROM unnest(ARRAY['run','inbox','activity','comment']) scope`)
	exec(`INSERT INTO labrastro_message_approved_target(workspace_id,autopilot_id,installation_id,target_key,target_type,source_kind,approved_by)
		SELECT workspace_id,autopilot_id,installation_id,target_key,target_type,source_kind,created_by
		FROM labrastro_message_route WHERE target_type='group'`)
	exec(`INSERT INTO labrastro_message_delivery(id,workspace_id,route_id,autopilot_id,dedup_key,
		source_kind,status,content_snapshot,target_snapshot,installation_id,target_key,lease_token,lease_expires_at)
		SELECT gen_random_uuid(),r.workspace_id,r.id,r.autopilot_id,r.id::text||':'||state,
			'test_send',state,'{}','{}',r.installation_id,r.target_key,
			CASE WHEN state='sending' THEN gen_random_uuid() END,
			CASE WHEN state='sending' THEN now()+interval '1 minute' END
		FROM labrastro_message_route r CROSS JOIN unnest(ARRAY['sent','sending']) state`)
	// A deleted preview route no longer supplies a test send's original scope.
	exec(`INSERT INTO labrastro_message_delivery(id,workspace_id,route_id,dedup_key,source_kind,status,
		content_snapshot,target_snapshot,installation_id,target_key)
		SELECT gen_random_uuid(),workspace_id,gen_random_uuid(),'orphan-test','test_send','queued',
			'{}','{}',installation_id,target_key FROM labrastro_message_route WHERE source_kind='inbox'`)
	exec(`INSERT INTO labrastro_message_delivery(id,workspace_id,route_id,source_ref_id,dedup_key,
		source_kind,status,content_snapshot,target_snapshot,installation_id,target_key)
		SELECT gen_random_uuid(),workspace_id,id,gen_random_uuid(),'source:'||source_kind,
			source_kind,'queued','{}','{}',installation_id,target_key
		FROM labrastro_message_route WHERE source_kind<>'run'`)
	exec(`INSERT INTO labrastro_message_receipt(delivery_id,workspace_id,installation_id,shard_index,shard_total,send_uuid,external_message_id)
		SELECT id,workspace_id,installation_id,0,1,id::text,'om_'||id::text
		FROM labrastro_message_delivery WHERE status='sent'`)
	upgrades := []string{"471_labrastro_message_source_scope", "472_labrastro_message_drop_preview_approval_index", "473_labrastro_message_project_approval_index"}
	if err := run("up", upgrades[:2]); err != nil {
		t.Fatal(err)
	}
	count(`SELECT count(*) FROM labrastro_message_route WHERE enabled AND source_kind='inbox'`, 1)
	count(`SELECT count(*) FROM labrastro_message_route WHERE enabled AND source_kind IN ('activity','comment')`, 0)
	count(`SELECT count(*) FROM labrastro_message_approved_target WHERE revoked_at IS NULL AND source_kind<>'run'`, 0)
	count(`SELECT count(*) FROM labrastro_message_approved_target WHERE revoked_at IS NULL AND source_kind='run'`, 1)
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE status='cancelled' AND autopilot_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL`, 7)
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE status='sent'`, 4)
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE source_scope='run' AND status='sending'`, 1)
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE source_scope IS NULL AND dedup_key='orphan-test' AND status='cancelled'`, 1)
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE source_kind='test_send' AND source_scope IN ('inbox','activity','comment')`, 6)
	count(`SELECT count(*) FROM labrastro_message_receipt`, 4)

	// A failed concurrent build leaves an invalid index. The real retry hook
	// must remove it before IF NOT EXISTS can otherwise silently skip it.
	exec(`INSERT INTO labrastro_message_approved_target(workspace_id,installation_id,target_key,target_type,source_kind,approved_by)
		SELECT workspace_id,installation_id,target_key,target_type,source_kind,created_by
		FROM labrastro_message_route CROSS JOIN generate_series(1,2) n WHERE source_kind='activity'`)
	if err := run("up", upgrades[2:]); err == nil {
		t.Fatal("duplicate workspace grants did not reject the index build")
	}
	assertIndexValidity(t, pool, schema, "uq_labrastro_message_approved_target_project_active", false)
	exec(`DELETE FROM labrastro_message_approved_target WHERE id=(SELECT id FROM labrastro_message_approved_target WHERE revoked_at IS NULL AND source_kind='activity' LIMIT 1)`)
	if err := run("up", upgrades[2:]); err != nil {
		t.Fatalf("repair invalid scope index: %v", err)
	}
	assertIndexValidity(t, pool, schema, "uq_labrastro_message_approved_target_project_active", true)
	exec(`INSERT INTO labrastro_message_approved_target(workspace_id,installation_id,target_key,target_type,source_kind,approved_by,project_id)
		SELECT workspace_id,installation_id,target_key,target_type,source_kind,created_by,gen_random_uuid()
		FROM labrastro_message_route CROSS JOIN generate_series(1,2) n WHERE source_kind='activity'`)
	count(`SELECT count(*) FROM labrastro_message_approved_target WHERE source_kind='activity' AND revoked_at IS NULL`, 3)
	down := append(slices.Clone(preview), upgrades...)
	slices.Reverse(down)
	if err := run("down", down); err == nil || !strings.Contains(err.Error(), "revoke project message target approvals") {
		t.Fatalf("project grants must block downgrade before DDL: %v", err)
	}
	assertIndexValidity(t, pool, schema, "uq_labrastro_message_approved_target_project_active", true)
	count(`SELECT count(*) FROM labrastro_message_delivery`, 12)
	exec(`UPDATE labrastro_message_approved_target SET revoked_at=now() WHERE source_kind<>'run' AND revoked_at IS NULL`)
	if err := run("down", down); err != nil {
		t.Fatalf("downgrade after revoking project consent: %v", err)
	}
	count(`SELECT count(*) FROM labrastro_message_route`, 1)
	count(`SELECT count(*) FROM labrastro_message_delivery`, 2)
	count(`SELECT count(*) FROM labrastro_message_receipt`, 1)
	count(`SELECT count(*) FROM labrastro_message_receipt r LEFT JOIN labrastro_message_delivery d ON d.id=r.delivery_id WHERE d.id IS NULL`, 0)
	count(`SELECT count(*) FROM labrastro_message_approved_target WHERE revoked_at IS NULL`, 1)
	// Re-applying the feature must also preserve the legacy automation data.
	if err := run("up", append(slices.Clone(preview), upgrades...)); err != nil {
		t.Fatalf("re-upgrade: %v", err)
	}
	count(`SELECT count(*) FROM labrastro_message_delivery WHERE source_scope='run'`, 2)
}
