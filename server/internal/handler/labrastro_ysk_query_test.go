package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type yskQueryCapture struct {
	pgx.Tx
	query string
}

func (c *yskQueryCapture) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	c.query = query
	return c.Tx.Query(ctx, query, args...)
}

type yskQueryPlan struct {
	Relation string         `json:"Relation Name"`
	Rows     float64        `json:"Actual Rows"`
	Removed  float64        `json:"Rows Removed by Filter"`
	Rechecks float64        `json:"Rows Removed by Index Recheck"`
	Loops    float64        `json:"Actual Loops"`
	Plans    []yskQueryPlan `json:"Plans"`
}

func (p yskQueryPlan) tipTuples() float64 {
	var rows float64
	if p.Relation == "labrastro_issue_tip" {
		rows = (p.Rows + p.Removed + p.Rechecks) * p.Loops
	}
	for _, child := range p.Plans {
		rows += child.tipTuples()
	}
	return rows
}

func TestLabrastroYSKActiveQueryCostDoesNotFollowHistory(t *testing.T) {
	f := newYSKFixture(t)
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Use the real schemas/indexes and generated query, but isolated temporary
	// tables so history size and ANALYZE cannot affect other packages' fixtures.
	for _, table := range []string{"agent", "issue", "agent_task_queue", "labrastro_issue_tip", "labrastro_issue_tip_state"} {
		exec(fmt.Sprintf("CREATE TEMP TABLE %s (LIKE public.%s INCLUDING ALL) ON COMMIT DROP", table, table))
	}
	exec(`INSERT INTO agent SELECT * FROM public.agent WHERE id=$1`, f.agent)
	exec(`INSERT INTO issue (workspace_id,title,creator_type,creator_id,number)
		SELECT $1,'history '||n,'member',$2,n FROM generate_series(1,20000) n`, f.WorkspaceID, testUserID)
	exec(`INSERT INTO agent_task_queue (agent_id,issue_id,runtime_id,status)
		SELECT $1,id,$2,'running' FROM issue WHERE number<=10`, f.agent, f.runtime)
	for _, table := range []string{"agent", "issue", "agent_task_queue", "labrastro_issue_tip_state"} {
		exec("ANALYZE " + table)
	}
	capture := &yskQueryCapture{Tx: tx}
	q := db.New(capture)
	for _, history := range []int{10000, 100000} {
		exec(`TRUNCATE labrastro_issue_tip`)
		exec(`INSERT INTO labrastro_issue_tip (workspace_id,issue_id,task_id,agent_id,tag,line,title,explanation)
			SELECT $1,i.id,gen_random_uuid(),$2,'you_should_know','tip '||n,'title','explanation'
			FROM issue i CROSS JOIN generate_series(1,5) n WHERE i.number<=$3`, f.WorkspaceID, f.agent, history/5)
		exec(`ANALYZE labrastro_issue_tip`)
		rows, err := q.LabrastroYSKListActiveTips(ctx, db.LabrastroYSKListActiveTipsParams{WorkspaceID: parseUUID(f.WorkspaceID), UserID: parseUUID(testUserID)})
		if err != nil || len(rows) != 50 {
			t.Fatalf("active result: rows=%d err=%v", len(rows), err)
		}
		name := fmt.Sprintf("ysk_active_%d", history)
		exec("PREPARE " + name + " (uuid,uuid) AS " + capture.query)
		for _, mode := range []string{"force_custom_plan", "force_generic_plan"} {
			exec("SET LOCAL plan_cache_mode = " + mode)
			var raw []byte
			explain := fmt.Sprintf("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE %s ('%s','%s')", name, f.WorkspaceID, testUserID)
			if err := tx.QueryRow(ctx, explain).Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var plans []struct {
				Plan yskQueryPlan `json:"Plan"`
				MS   float64      `json:"Execution Time"`
			}
			if err := json.Unmarshal(raw, &plans); err != nil || len(plans) != 1 {
				t.Fatalf("bad plan: %s; err=%v", raw, err)
			}
			scanned := plans[0].Plan.tipTuples()
			t.Logf("history=%d mode=%s tip tuples=%.0f execution=%.3fms", history, mode, scanned, plans[0].MS)
			// Assert database work, not wall-clock timing. Only the ten running
			// issues' tips should be visited, even under a generic cached plan.
			if scanned < 50 || scanned > 500 {
				t.Fatalf("active query scans history: %.0f tip tuples; plan=%s", scanned, raw)
			}
		}
		exec("DEALLOCATE " + name)
	}
}
