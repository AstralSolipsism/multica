package handler

import (
	"fmt"
	"slices"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLabrastroYSKActiveTipsExcludeInvalid(t *testing.T) {
	f := newYSKFixture(t)
	valid := f.tip(t, "current advice")
	f.tip(t, "overturned advice", testutil.Cols{"status": "overturned"})
	f.tip(t, "changed source", testutil.Cols{"status": "source_changed"})
	if tips := f.list(t, true, false, testUserID); len(tips) != 1 || tips[0].ID != valid {
		t.Fatalf("active tips = %+v, want only valid tip %s", tips, valid)
	}
}

func TestLabrastroYSKKnownTopicsRetainMostRecent(t *testing.T) {
	f := newYSKFixture(t)
	// Strictly older than the state-write transaction, with no timestamp ties.
	f.Exec(t, `INSERT INTO labrastro_known_topic(workspace_id,user_id,topic,updated_at)
		SELECT $1,$2,'old topic '||lpad(n::text,2,'0'),now()-n*interval '1 minute'
		FROM generate_series(1,50) n`, f.WorkspaceID, testUserID)
	id := f.tip(t, "new topic")
	testutil.Call(t, f.h.LabrastroSetTipState, f.request("POST", map[string]any{"state": "known"}, "tipId", id)).Want(200)

	var got []string
	f.QueryRow(t, `SELECT array_agg(topic ORDER BY topic) FROM labrastro_known_topic
		WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, testUserID).Scan(&got)
	want := []string{"new topic"}
	for i := 1; i < 50; i++ {
		want = append(want, fmt.Sprintf("old topic %02d", i))
	}
	if !slices.Equal(got, want) {
		t.Fatalf("retained topics = %v, want new topic and the 49 most recent old topics: %v", got, want)
	}
}

func TestLabrastroYSKReportContinuesAfterSkippedTip(t *testing.T) {
	for _, skipped := range []string{"quota", "duplicate"} {
		t.Run(skipped, func(t *testing.T) {
			f := newYSKFixture(t)
			priorTask := f.Task(t, f.agent, testutil.Cols{"issue_id": f.issue, "runtime_id": f.runtime, "status": "completed"})
			priorTip := f.tip(t, "superseded advice", testutil.Cols{"task_id": priorTask})
			tips := []labrastroYSKInputTip{yskInput("first"), yskInput("second"), yskInput("third"), yskInput("over quota")}
			wantLines := []string{"first", "second", "third"}
			if skipped == "duplicate" {
				f.tip(t, "duplicate")
				tips = []labrastroYSKInputTip{yskInput("duplicate"), yskInput("new after duplicate")}
				wantLines = []string{"duplicate", "new after duplicate"}
			}
			f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: tips,
				Overturned: []labrastroYSKInputOverturn{{TipID: priorTip, Reason: "new decision"}}})
			var gotLines []string
			f.QueryRow(t, `SELECT array_agg(line ORDER BY line) FROM labrastro_issue_tip WHERE task_id=$1`, f.task).Scan(&gotLines)
			if !slices.Equal(gotLines, wantLines) {
				t.Fatalf("persisted lines = %v, want %v", gotLines, wantLines)
			}
			if f.Count(t, `SELECT count(*) FROM labrastro_issue_tip WHERE id=$1 AND status='overturned' AND overturned_by_task_id=$2`, priorTip, f.task) != 1 {
				t.Fatal("skipped tip prevented the later overturn")
			}
		})
	}
}

func TestLabrastroYSKDispatchedTaskAcceptsReport(t *testing.T) {
	f := newYSKFixture(t)
	f.Exec(t, `UPDATE agent_task_queue SET status='dispatched', started_at=NULL WHERE id=$1`, f.task)
	f.report(t, labrastroYSKReport{Version: 1, Kind: "light", Step: 1, Tips: []labrastroYSKInputTip{yskInput("reported before running")}})
	if tips := f.list(t, false, false, testUserID); len(tips) != 1 || tips[0].Line != "reported before running" {
		t.Fatalf("dispatched task report was not persisted: %+v", tips)
	}
}
