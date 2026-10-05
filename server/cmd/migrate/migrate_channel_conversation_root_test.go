package main

import (
	"context"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/migrations"
)

const conversationRootMigration = "551_channel_conversation_root"

// Minimal pre-migration tables intentionally omit the new column. Current
// dbfx.Task fixtures require the post-migration schema and cannot model this.
func conversationRootFixture(t *testing.T) (context.Context, *pgxpool.Pool, runOptions) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	t.Cleanup(cancel)
	admin := openTestPool(t)
	schema := createScratchSchema(t, ctx, admin, "conversation_root_")
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `CREATE TABLE agent_task_queue (
		id UUID PRIMARY KEY, originator_source TEXT, retry_of_task_id UUID,
		delegated_from_task_id UUID, parent_task_id UUID, status TEXT DEFAULT 'queued'
	)`); err != nil {
		t.Fatal(err)
	}
	return ctx, pool, runOptions{
		Direction: "up", Files: realMigrationFiles(t, []string{conversationRootMigration}, "up"),
		SchemaMigrationsTable: schema + ".schema_migrations",
		AdvisoryLockKey:       int64(rand.Uint64()&0x7fffffffffffffff) | 1,
		Hooks:                 hooksForDirection("up"),
	}
}

func assertConversationRoot(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(conversation_root_task_id::text, '')
		FROM agent_task_queue WHERE id = $1`, id).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("task %s root = %q, want %q (empty means NULL)", id, got, want)
	}
}

func TestChannelConversationRootMigrationAncestry(t *testing.T) {
	cases := []struct {
		name, source, retry, delegated, parent, backfill, stamped string
	}{
		{name: "channel", source: "channel_integration", backfill: "channel", stamped: "channel"},
		{name: "ordinary", source: "member"},
		{name: "null_source"},
		{name: "retry", source: "member", retry: "channel", backfill: "channel", stamped: "channel"},
		{name: "delegation", source: "delegation", delegated: "retry", backfill: "channel", stamped: "channel"},
		{name: "comment", source: "comment_source", delegated: "delegation", backfill: "channel", stamped: "channel"},
		{name: "nested_retry", source: "member", retry: "comment", backfill: "channel", stamped: "channel"},
		{name: "ordinary_retry", source: "member", retry: "ordinary"},
		{name: "ordinary_delegation", source: "delegation", delegated: "ordinary_retry"},
		{name: "ordinary_comment", source: "comment_source", delegated: "ordinary_delegation"},
		{name: "ordinary_task_tree", source: "member", parent: "channel", delegated: "channel"},
		{name: "retry_wins", source: "delegation", retry: "ordinary", delegated: "channel"},
		{name: "channel_retry_wins", source: "channel_integration", retry: "ordinary"},
		{name: "delegation_without_parent", source: "delegation"},
		{name: "comment_without_parent", source: "comment_source"},
		{name: "missing_retry", source: "member", retry: "missing", backfill: "missing_retry", stamped: "missing_retry"},
		{name: "missing_delegation", source: "delegation", delegated: "missing", backfill: "missing_delegation", stamped: "missing_delegation"},
		{name: "missing_comment", source: "comment_source", delegated: "missing", backfill: "missing_comment", stamped: "missing_comment"},
		{name: "self_retry", source: "member", retry: "self_retry", backfill: "self_retry", stamped: "self_retry"},
		{name: "self_delegation", source: "delegation", delegated: "self_delegation", backfill: "self_delegation", stamped: "self_delegation"},
		// Backfill marks each unresolved record with its own ID. On INSERT,
		// cycle_a's parent is missing; later descendants inherit that frozen ID.
		{name: "cycle_a", source: "delegation", delegated: "cycle_b", backfill: "cycle_a", stamped: "cycle_a"},
		{name: "cycle_b", source: "member", retry: "cycle_a", backfill: "cycle_b", stamped: "cycle_a"},
		{name: "cycle_child", source: "comment_source", delegated: "cycle_b", backfill: "cycle_child", stamped: "cycle_a"},
	}
	for _, mode := range []string{"backfill", "insert_trigger"} {
		t.Run(mode, func(t *testing.T) {
			ctx, pool, opts := conversationRootFixture(t)
			ids := map[string]string{"missing": uuid.NewString()}
			for _, tc := range cases {
				ids[tc.name] = uuid.NewString()
			}
			if mode == "insert_trigger" {
				if err := runMigrations(ctx, pool, opts); err != nil {
					t.Fatal(err)
				}
			}
			for _, tc := range cases {
				if _, err := pool.Exec(ctx, `INSERT INTO agent_task_queue
					(id, originator_source, retry_of_task_id, delegated_from_task_id, parent_task_id)
					VALUES ($1, NULLIF($2, ''), NULLIF($3, '')::uuid, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid)`,
					ids[tc.name], tc.source, ids[tc.retry], ids[tc.delegated], ids[tc.parent]); err != nil {
					t.Fatalf("seed %s: %v", tc.name, err)
				}
			}
			if mode == "backfill" {
				if err := runMigrations(ctx, pool, opts); err != nil {
					t.Fatal(err)
				}
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					want := tc.backfill
					if mode == "insert_trigger" {
						want = tc.stamped
					}
					assertConversationRoot(t, ctx, pool, ids[tc.name], ids[want])
				})
			}

			// Changing lineage recomputes the reference, with retry taking
			// precedence. Unchanged lineage must preserve even a NULL root.
			for _, update := range []struct {
				sql  string
				args []any
				want string
			}{
				{`UPDATE agent_task_queue SET originator_source='delegation', delegated_from_task_id=$2 WHERE id=$1`, []any{ids["ordinary_task_tree"], ids["channel"]}, "channel"},
				{`UPDATE agent_task_queue SET retry_of_task_id=$2 WHERE id=$1`, []any{ids["ordinary_task_tree"], ids["ordinary"]}, ""},
				{`UPDATE agent_task_queue SET originator_source=originator_source, conversation_root_task_id=$2 WHERE id=$1`, []any{ids["ordinary_task_tree"], ids["channel"]}, ""},
				{`UPDATE agent_task_queue SET retry_of_task_id=$2 WHERE id=$1`, []any{ids["ordinary_task_tree"], ids["missing"]}, "ordinary_task_tree"},
				{`UPDATE agent_task_queue SET retry_of_task_id=retry_of_task_id, conversation_root_task_id=NULL WHERE id=$1`, []any{ids["ordinary_task_tree"]}, "ordinary_task_tree"},
			} {
				if _, err := pool.Exec(ctx, update.sql, update.args...); err != nil {
					t.Fatal(err)
				}
				assertConversationRoot(t, ctx, pool, ids["ordinary_task_tree"], ids[update.want])
			}
		})
	}
}

func TestChannelConversationRootMigrationReplayAndRoundTrip(t *testing.T) {
	ctx, pool, opts := conversationRootFixture(t)
	channel, ordinary, externalRetry, ordinaryRetry := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO agent_task_queue (id, originator_source, retry_of_task_id)
		VALUES ($1, 'channel_integration', NULL), ($2, 'member', NULL),
		       ($3, 'member', $1), ($4, 'member', $2)`, channel, ordinary, externalRetry, ordinaryRetry); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	// With intact ancestry a down/up round trip can derive the same roots.
	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, []string{conversationRootMigration}, "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, []string{conversationRootMigration}, "up"), hooksForDirection("up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	assertConversationRoot(t, ctx, pool, channel, channel)
	assertConversationRoot(t, ctx, pool, ordinary, "")
	assertConversationRoot(t, ctx, pool, externalRetry, channel)
	assertConversationRoot(t, ctx, pool, ordinaryRetry, "")
	if _, err := pool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id IN ($1, $2)`, channel, ordinary); err != nil {
		t.Fatal(err)
	}
	// Ordinary writes after history pruning must not re-derive authority.
	if _, err := pool.Exec(ctx, `UPDATE agent_task_queue SET originator_source=originator_source,
		status='completed', conversation_root_task_id=NULL`); err != nil {
		t.Fatal(err)
	}
	assertConversationRoot(t, ctx, pool, externalRetry, channel)
	assertConversationRoot(t, ctx, pool, ordinaryRetry, "")
	// Simulate SQL commit followed by a lost ledger write, forcing actual replay.
	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations WHERE version=$1`, conversationRootMigration); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatalf("replay: %v", err)
	}
	assertConversationRoot(t, ctx, pool, externalRetry, channel)
	assertConversationRoot(t, ctx, pool, ordinaryRetry, "")

	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, []string{conversationRootMigration}, "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var objectsRemain bool
	if err := pool.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
		       AND table_name='agent_task_queue' AND column_name='conversation_root_task_id')
		OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='agent_task_queue'::regclass AND tgname='trg_task_conversation_root')
		OR to_regprocedure('stamp_task_conversation_root()') IS NOT NULL
		OR EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, conversationRootMigration).Scan(&objectsRemain); err != nil || objectsRemain {
		t.Fatalf("down left migration objects/ledger: %t, %v", objectsRemain, err)
	}
	opts.Direction, opts.Files, opts.Hooks = "up", realMigrationFiles(t, []string{conversationRootMigration}, "up"), hooksForDirection("up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	// Down is lossy: up only sees missing parents, so cannot restore either
	// the deleted external root's ID or the ordinary task's former NULL root.
	assertConversationRoot(t, ctx, pool, externalRetry, externalRetry)
	assertConversationRoot(t, ctx, pool, ordinaryRetry, ordinaryRetry)
	child := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO agent_task_queue (id, originator_source, delegated_from_task_id)
		VALUES ($1, 'comment_source', $2)`, child, externalRetry); err != nil {
		t.Fatal(err)
	}
	assertConversationRoot(t, ctx, pool, child, externalRetry)
}

func TestRunMigrationsRecordsBoth551Stems(t *testing.T) {
	files, err := migrations.Files("up")
	if err != nil {
		t.Fatal(err)
	}
	files = slices.DeleteFunc(files, func(file string) bool {
		return !strings.HasPrefix(migrations.ExtractVersion(file), "551_")
	})
	want := []string{conversationRootMigration, "551_pr_merge_status"}
	var found []string
	for _, file := range files {
		found = append(found, migrations.ExtractVersion(file))
	}
	if !slices.Equal(found, want) {
		t.Fatalf("discovered 551 stems = %v, want %v", found, want)
	}
	for _, upstreamFirst := range []bool{false, true} {
		name := "fresh"
		if upstreamFirst {
			name = "upstream_already_applied"
		}
		t.Run(name, func(t *testing.T) {
			ctx, pool, opts := conversationRootFixture(t)
			if _, err := pool.Exec(ctx, `
				CREATE TABLE workspace (id UUID, settings JSONB);
				CREATE TABLE issue (id UUID, workspace_id UUID);
				CREATE TABLE issue_pull_request (issue_id UUID, pull_request_id UUID, close_intent BOOLEAN);
				CREATE TABLE github_pull_request (id UUID, state TEXT);
				CREATE TABLE issue_vcs_pull_request (issue_id UUID, pull_request_id UUID, close_intent BOOLEAN);
				CREATE TABLE vcs_pull_request (id UUID, state TEXT);
				INSERT INTO workspace VALUES (gen_random_uuid(), '{"pr_auto_complete_enabled": false}');
				INSERT INTO agent_task_queue (id, originator_source) VALUES (gen_random_uuid(), 'channel_integration');
			`); err != nil {
				t.Fatal(err)
			}
			if upstreamFirst {
				opts.Files = files[1:]
				if err := runMigrations(ctx, pool, opts); err != nil {
					t.Fatal(err)
				}
			}
			opts.Files = files
			for range 2 {
				if err := runMigrations(ctx, pool, opts); err != nil {
					t.Fatal(err)
				}
			}
			var versions []string
			if err := pool.QueryRow(ctx, `SELECT array_agg(version ORDER BY version) FROM schema_migrations`).Scan(&versions); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(versions, want) {
				t.Fatalf("ledger = %v, want both full stems %v", versions, want)
			}
			var rootOK, settingOK bool
			if err := pool.QueryRow(ctx, `SELECT conversation_root_task_id = id FROM agent_task_queue`).Scan(&rootOK); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT settings->>'pr_merge_status' = 'none' FROM workspace`).Scan(&settingOK); err != nil {
				t.Fatal(err)
			}
			if !rootOK || !settingOK {
				t.Fatalf("both migrations must execute: root=%t, PR setting=%t", rootOK, settingOK)
			}
		})
	}
}
