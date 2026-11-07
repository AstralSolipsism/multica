package service

import (
	"context"
	"os"
	"testing"
)

// A delegated-failure recovery signal is a durable outbox row: it survives a
// crash between being written and being dispatched. One left by external
// conversation work before 9066 must not replay as a new, unrooted task after
// it; a member's must still replay. Every task is terminal before the upgrade,
// so this does not depend on a request racing the migration.
func TestConversationRetirementSettlesRecoverySignals(t *testing.T) {
	for _, tc := range []struct {
		name     string
		external bool
		replayed int
	}{
		{"external", true, 0},
		{"member", false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			f, svc := seedDelegatedFailureFixture(t)
			exec := func(sql string, args ...any) {
				t.Helper()
				if _, err := f.pool.Exec(ctx, sql, args...); err != nil {
					t.Fatal(err)
				}
			}
			if tc.external {
				// The lineage 551 stamped before the upgrade: the coordinator was
				// delegated by a completed external root, and so was its worker.
				var root string
				if err := f.pool.QueryRow(ctx, `INSERT INTO agent_task_queue (
						agent_id, runtime_id, status, priority, originator_user_id, accountable_user_id, originator_source, completed_at)
					VALUES ($1,$2,'completed',0,$3,$3,'channel_integration',now()) RETURNING id::text`,
					f.coordinator, f.runtimeID, f.userID).Scan(&root); err != nil {
					t.Fatal(err)
				}
				exec(`UPDATE agent_task_queue SET conversation_root_task_id=id WHERE id=$1`, root)
				exec(`UPDATE agent_task_queue SET originator_source='delegation', delegated_from_task_id=$2,
					conversation_root_task_id=$2 WHERE id=$1`, f.sourceTask, root)
				t.Cleanup(func() { f.pool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id=$1`, root) })
			}
			failed := f.insertWorkerTask(t, "failed", "comment", 1, 2)
			if tc.external {
				exec(`UPDATE agent_task_queue SET conversation_root_task_id=(SELECT conversation_root_task_id FROM agent_task_queue WHERE id=$2) WHERE id=$1`, failed, f.sourceTask)
			}
			if target, created, err := svc.ensureDelegatedFailureRecoveryComment(ctx, failed); err != nil || target == nil || !created {
				t.Fatalf("seed pending recovery signal: created=%v err=%v", created, err)
			}
			migration, err := os.ReadFile("../../migrations/9066_labrastro_retire_conversation_provenance.up.sql")
			if err != nil {
				t.Fatal(err)
			}
			exec(string(migration))
			result, err := svc.RecoverPendingDelegatedFailures(ctx, 100)
			if err != nil {
				t.Fatal(err)
			}
			var runnable int
			if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue
				WHERE trigger_evidence_kind='delegated_failure' AND trigger_evidence_ref_id=$1
				  AND status IN ('queued','dispatched','running','waiting_local_directory','deferred')`, failed).Scan(&runnable); err != nil {
				t.Fatal(err)
			}
			if result.Replayed != tc.replayed || runnable != tc.replayed {
				t.Fatalf("after 9066: recovery %+v, runnable recovery tasks %d; want %d", result, runnable, tc.replayed)
			}
		})
	}
}
