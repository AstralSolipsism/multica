package main

import (
	"context"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// issue_dependency's blocking edges become native issue_blocker rows once,
// keep their direction and workspace, arm the blocker wakeup only where the
// blocker is still open, and never stop the upgrade when upstream's graph
// rules refuse one of them.
func TestLabrastroIssueDependencyMigratesToBlockers(t *testing.T) {
	ctx := context.Background()
	pool := openTestPool(t)
	up, err := os.ReadFile("../../migrations/9079_labrastro_migrate_issue_dependency_to_blocker.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	down, err := os.ReadFile("../../migrations/9079_labrastro_migrate_issue_dependency_to_blocker.down.sql")
	if err != nil {
		t.Fatal(err)
	}

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	ws, foreignWS := insertMigrationWorkspace(t, ctx, pool, "dep-migrate-"+suffix), insertMigrationWorkspace(t, ctx, pool, "dep-foreign-"+suffix)
	fx := testutil.New(pool, ws, uuid.NewString())
	// An issue an agent created keeps that attribution on its stored edges.
	owner := fx.User(t, "Agent owner", "dep-agent-owner-"+suffix+"@multica.test")
	fx.UserID = owner
	foreign := testutil.New(pool, foreignWS, uuid.NewString())
	fx.Cleanup(t, "DELETE FROM issue_blocker WHERE workspace_id = ANY($1::uuid[])", []string{ws, foreignWS})

	dependent := fx.Issue(t, "Dependent", testutil.Cols{"status": "in_progress"})
	blocker := fx.Issue(t, "Blocker")
	agent := fx.Agent(t, "Created the reverse-spelling dependent", "")
	reverse := fx.Issue(t, "Stored the other way round", testutil.Cols{"status": "in_progress", "creator_type": "agent", "creator_id": agent})
	finished := fx.Issue(t, "Finished historical issue", testutil.Cols{"status": "done"})
	closedBlocker := fx.Issue(t, "Closed blocker", testutil.Cols{"status": "done"})
	related := fx.Issue(t, "Only related")
	parent := fx.Issue(t, "Parent")
	first := fx.Issue(t, "Stage 1", testutil.Cols{"parent_issue_id": parent, "stage": 1})
	second := fx.Issue(t, "Stage 2", testutil.Cols{"parent_issue_id": parent, "stage": 2})
	outside := foreign.Issue(t, "Another workspace")
	dependency := func(issue, dependsOn, kind string) {
		fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": issue, "depends_on_issue_id": dependsOn, "type": kind})
	}
	dependency(dependent, blocker, "blocked_by")
	dependency(blocker, dependent, "blocks") // same edge in both spellings: deduplicated once
	dependency(blocker, reverse, "blocks")   // reverse-only spelling: only the blocks branch can migrate it
	dependency(finished, closedBlocker, "blocked_by")
	dependency(dependent, related, "related")
	dependency(dependent, dependent, "blocked_by")
	dependency(dependent, outside, "blocked_by")
	// Stage order already makes stage 2 wait for stage 1; the stored edge says
	// the opposite, and a child blocked by its own parent is refused as well.
	dependency(first, second, "blocked_by")
	dependency(first, parent, "blocked_by")

	if _, err := pool.Exec(ctx, string(up)); err != nil {
		t.Fatalf("apply the upgrade migration: %v", err)
	}
	createdBy := fx.UserID
	assertBlockers(t, ctx, pool, ws, [][4]string{
		{reverse, blocker, "agent", agent},
		{dependent, blocker, "member", createdBy},
		{finished, closedBlocker, "member", createdBy},
	})
	if n := countMigrationRows(t, ctx, pool, "SELECT count(*) FROM issue_blocker WHERE workspace_id=$1", foreignWS); n != 0 {
		t.Fatalf("cross-workspace edge migrated: %d blockers in the foreign workspace", n)
	}
	// The blocker trigger arms the system wakeup only where a blocker is open;
	// a finished historical issue gains the edge and no wakeup.
	for _, issue := range []struct {
		id   string
		want int
	}{{dependent, 1}, {reverse, 1}, {finished, 0}, {first, 0}} {
		if n := countMigrationRows(t, ctx, pool, "SELECT count(*) FROM issue_wakeup WHERE workspace_id=$1 AND system_rule='blockers_done' AND issue_id=$2", ws, issue.id); n != issue.want {
			t.Fatalf("blocker wakeups for %s = %d, want %d", issue.id, n, issue.want)
		}
	}
	kept := 9
	if n := countMigrationRows(t, ctx, pool, "SELECT count(*) FROM issue_dependency WHERE issue_id = ANY($1::uuid[])", []string{dependent, blocker, reverse, finished, first}); n != kept {
		t.Fatalf("issue_dependency rows = %d, want the historical %d kept", n, kept)
	}

	// A rerun and the down direction both leave the stored graph as it is.
	if _, err := pool.Exec(ctx, string(up)); err != nil {
		t.Fatalf("rerun the upgrade migration: %v", err)
	}
	if _, err := pool.Exec(ctx, string(down)); err != nil {
		t.Fatalf("apply the down migration: %v", err)
	}
	assertBlockers(t, ctx, pool, ws, [][4]string{
		{reverse, blocker, "agent", agent},
		{dependent, blocker, "member", createdBy},
		{finished, closedBlocker, "member", createdBy},
	})
}

func insertMigrationWorkspace(t *testing.T, ctx context.Context, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `INSERT INTO workspace (name, slug) VALUES ($1, $1) RETURNING id::text`, slug).Scan(&id); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, id)
	})
	return id
}

func assertBlockers(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workspace string, want [][4]string) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT issue_id::text, blocker_issue_id::text, created_by_type, created_by_id::text
		FROM issue_blocker WHERE workspace_id = $1 ORDER BY issue_id::text, blocker_issue_id::text`, workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got [][4]string
	for rows.Next() {
		var b [4]string
		if err := rows.Scan(&b[0], &b[1], &b[2], &b[3]); err != nil {
			t.Fatal(err)
		}
		got = append(got, b)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	// Issue ids are random, so both sides are compared in one canonical order.
	describe := func(rows [][4]string) []string {
		keys := make([]string, 0, len(rows))
		for _, b := range rows {
			keys = append(keys, strings.Join(b[:2], " <- ")+" by "+b[2]+" "+b[3])
		}
		sort.Strings(keys)
		return keys
	}
	if gotKeys, wantKeys := describe(got), describe(want); !reflect.DeepEqual(gotKeys, wantKeys) {
		t.Fatalf("blockers = %v, want %v", gotKeys, wantKeys)
	}
}

func countMigrationRows(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}
