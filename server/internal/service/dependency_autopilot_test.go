package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestDependencyAutopilotBoundIssueAdmission(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	agent := f.privateAgentOwnedBy(t, owner, "dependency automation")
	apID, trigger := f.autopilotWithTrigger(t, agent, owner, owner)
	a := f.Issue(t, "unfinished prerequisite")
	b := f.Issue(t, "bound continuation")
	f.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": a, "type": "blocked_by"})
	runID := f.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": apID, "trigger_id": trigger, "source": "schedule", "status": "running", "issue_id": b})
	ctx := context.Background()
	ap, err := f.q.GetAutopilot(ctx, util.MustParseUUID(apID))
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.q.GetAutopilotRun(ctx, util.MustParseUUID(runID))
	if err != nil {
		t.Fatal(err)
	}
	err = f.svc.dispatchRunOnly(ctx, ap, &run, pgtype.UUID{})
	var dep *DependencyError
	if !errors.As(err, &dep) || dep.Code != "dependency_unsatisfied" {
		t.Fatalf("scheduled issue continuation bypassed admission: %v", err)
	}
	var count int
	f.QueryRow(t, "SELECT count(*) FROM agent_task_queue WHERE autopilot_run_id=$1", runID).Scan(&count)
	if count != 0 {
		t.Fatal("blocked automation left a queue row")
	}
	f.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id=$1", a)
	if err = f.svc.dispatchRunOnly(ctx, ap, &run, pgtype.UUID{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Exec(t, "DELETE FROM agent_task_queue WHERE autopilot_run_id=$1", runID) })
	task, err := f.q.GetAutopilotTaskByRun(ctx, util.MustParseUUID(runID))
	if err != nil || task.IssueID != util.MustParseUUID(b) || len(task.DependencyAdmission) != 0 {
		t.Fatalf("autopilot lost its issue binding: %+v %v", task, err)
	}
}
