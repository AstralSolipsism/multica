package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestWakeupConversationMigrationBackfillsAndReplaysWithoutLosingConsent(t *testing.T) {
	ctx := context.Background()
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "wakeup_consent")
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `
CREATE TABLE agent_task_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), originator_source text,
 retry_of_task_id uuid, delegated_from_task_id uuid, originator_user_id uuid,
 trigger_evidence_kind text, trigger_evidence_ref_id uuid);
CREATE TABLE issue_wakeup(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_task_id uuid, created_by uuid);
`); err != nil {
		t.Fatal(err)
	}
	apply := func(stem, direction string) {
		t.Helper()
		if err := runMigrations(ctx, pool, runOptions{Direction: direction,
			Files:                 []string{filepath.Join("../../migrations", stem+"."+direction+".sql")},
			SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: migrationAdvisoryLockKey}); err != nil {
			t.Fatal(err)
		}
	}
	apply("551_channel_conversation_root", "up")
	var owner, root, source, wakeTask, child, rule, nextRule, ordinary, ordinaryRule, missing, orphanTask, orphanRule pgtype.UUID
	row := func(dest *pgtype.UUID, sql string, args ...any) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(dest); err != nil {
			t.Fatal(err)
		}
	}
	row(&owner, "SELECT gen_random_uuid()")
	row(&missing, "SELECT gen_random_uuid()")
	row(&root, "INSERT INTO agent_task_queue(originator_source,originator_user_id) VALUES('channel_integration',$1) RETURNING id", owner)
	row(&source, "INSERT INTO agent_task_queue(originator_source,delegated_from_task_id,originator_user_id) VALUES('delegation',$1,$2) RETURNING id", root, owner)
	row(&wakeTask, "INSERT INTO agent_task_queue(originator_source,delegated_from_task_id,originator_user_id) VALUES('trigger_owner',$1,$2) RETURNING id", source, owner)
	row(&child, "INSERT INTO agent_task_queue(originator_source,delegated_from_task_id,originator_user_id) VALUES('comment_source',$1,$2) RETURNING id", wakeTask, owner)
	row(&rule, "INSERT INTO issue_wakeup(source_task_id,created_by) VALUES($1,$2) RETURNING id", source, owner)
	row(&nextRule, "INSERT INTO issue_wakeup(source_task_id,created_by) VALUES($1,$2) RETURNING id", wakeTask, owner)
	row(&ordinary, "INSERT INTO agent_task_queue(originator_source,originator_user_id) VALUES('direct_human',$1) RETURNING id", owner)
	row(&ordinaryRule, "INSERT INTO issue_wakeup(source_task_id,created_by) VALUES($1,$2) RETURNING id", ordinary, owner)
	row(&orphanTask, "INSERT INTO agent_task_queue(originator_source,delegated_from_task_id,originator_user_id) VALUES('trigger_owner',$1,$2) RETURNING id", missing, owner)
	row(&orphanRule, "INSERT INTO issue_wakeup(source_task_id,created_by) VALUES($1,$2) RETURNING id", missing, owner)
	var ordinaryWake, ordinaryRetry, cycleA, cycleB pgtype.UUID
	row(&ordinaryWake, "INSERT INTO agent_task_queue(originator_source,delegated_from_task_id) VALUES('trigger_owner',$1) RETURNING id", ordinary)
	row(&ordinaryRetry, "INSERT INTO agent_task_queue(originator_source,retry_of_task_id,delegated_from_task_id) VALUES('trigger_owner',$1,$2) RETURNING id", ordinaryWake, root)
	row(&cycleA, "SELECT gen_random_uuid()")
	row(&cycleB, "SELECT gen_random_uuid()")
	row(&cycleA, "INSERT INTO agent_task_queue(id,originator_source,delegated_from_task_id) VALUES($1,'trigger_owner',$2) RETURNING id", cycleA, cycleB)
	row(&cycleB, "INSERT INTO agent_task_queue(id,originator_source,delegated_from_task_id) VALUES($1,'trigger_owner',$2) RETURNING id", cycleB, cycleA)
	const migration = "564_wakeup_conversation_root"
	apply(migration, "up")
	assertRoot := func(table string, id, want pgtype.UUID) {
		t.Helper()
		var got pgtype.UUID
		row(&got, "SELECT conversation_root_task_id FROM "+table+" WHERE id=$1", id)
		if got != want {
			t.Fatalf("%s root = %v, want %v", table, got, want)
		}
	}
	for _, task := range []pgtype.UUID{root, source, wakeTask, child} {
		assertRoot("agent_task_queue", task, root)
	}
	for _, w := range []pgtype.UUID{rule, nextRule} {
		assertRoot("issue_wakeup", w, root)
	}
	assertRoot("issue_wakeup", ordinaryRule, pgtype.UUID{})
	assertRoot("agent_task_queue", orphanTask, orphanTask)
	assertRoot("issue_wakeup", orphanRule, missing)
	assertRoot("agent_task_queue", ordinaryWake, pgtype.UUID{})
	assertRoot("agent_task_queue", ordinaryRetry, pgtype.UUID{})
	assertRoot("agent_task_queue", cycleA, cycleA)
	assertRoot("agent_task_queue", cycleB, cycleB)
	if _, err := pool.Exec(ctx, "DELETE FROM agent_task_queue WHERE id=$1", source); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM schema_migrations WHERE version=$1", migration); err != nil {
		t.Fatal(err)
	}
	apply(migration, "up")
	assertRoot("issue_wakeup", rule, root)
	var queued, retry pgtype.UUID
	row(&queued, `INSERT INTO agent_task_queue(originator_source,delegated_from_task_id,originator_user_id,trigger_evidence_kind,trigger_evidence_ref_id)
VALUES('trigger_owner',$1,$2,'issue_wakeup',$3) RETURNING id`, source, owner, rule)
	assertRoot("agent_task_queue", queued, root)
	row(&retry, "INSERT INTO agent_task_queue(originator_source,retry_of_task_id,originator_user_id) VALUES('retry',$1,$2) RETURNING id", queued, owner)
	assertRoot("agent_task_queue", retry, root)
	if _, err := pool.Exec(ctx, "UPDATE issue_wakeup SET source_task_id=source_task_id WHERE id=$1", rule); err != nil {
		t.Fatal(err)
	}
	assertRoot("issue_wakeup", rule, root)
	apply(migration, "down")
	assertRoot("agent_task_queue", queued, root)
	apply(migration, "up")
	// Down discarded the rule's durable evidence: missing source history now
	// fails closed instead of fabricating renewed consent from today's grant.
	assertRoot("issue_wakeup", rule, source)
}
