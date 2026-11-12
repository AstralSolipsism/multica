package service

import (
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestBaselineCarrierCreateReusesLockedThread(t *testing.T) {
	pool := sharedTestPool(t)
	f := testutil.New(pool, "", "")
	f.UserID = f.User(t, "Wiki author", uuid.NewString()+"@multica.test")
	f.WorkspaceID = f.Workspace(t, "Wiki workspace", "wiki-"+uuid.NewString())
	f.Member(t, f.WorkspaceID, f.UserID, "owner")
	project := f.Project(t, "Wiki project")
	f.Cleanup(t, `DELETE FROM issue WHERE project_id=$1`, project)
	thread := f.Insert(t, "project_baseline_thread", testutil.Cols{
		"workspace_id": f.WorkspaceID, "project_id": project, "page_id": uuid.NewString(),
		"anchor_kind": "section", "section_anchor": "A", "section_title": "A",
		"created_by_type": "member", "created_by_id": f.UserID,
	})
	q, bus := db.New(pool), events.New()
	createdEvents := 0
	bus.Subscribe(protocol.EventIssueCreated, func(events.Event) { createdEvents++ })
	svc := NewIssueService(q, pool, bus, nil, &TaskService{Queries: q, TxStarter: pool, Bus: bus})
	params := IssueCreateParams{
		WorkspaceID: util.MustParseUUID(f.WorkspaceID), ProjectID: util.MustParseUUID(project),
		Title: "Wiki carrier", Priority: "medium", CreatorType: "member", CreatorID: util.MustParseUUID(f.UserID),
	}
	opts := IssueCreateOpts{BaselineThreadID: util.MustParseUUID(thread), ActorID: f.UserID}
	first, err := svc.Create(t.Context(), params, opts)
	if err != nil {
		t.Fatal(err)
	}
	var bound string
	f.QueryRow(t, `SELECT issue_id FROM project_baseline_thread WHERE id=$1`, thread).Scan(&bound)
	if bound != util.UUIDToString(first.Issue.ID) {
		t.Fatalf("thread carrier = %s, want %s", bound, util.UUIDToString(first.Issue.ID))
	}
	beforeCount := f.Count(t, `SELECT count(*) FROM issue WHERE workspace_id=$1`, f.WorkspaceID)
	var beforeNumber, afterNumber int
	f.QueryRow(t, `SELECT issue_counter FROM workspace WHERE id=$1`, f.WorkspaceID).Scan(&beforeNumber)
	if beforeCount != 1 || createdEvents != 1 || beforeNumber != int(first.Issue.Number) {
		t.Fatalf("initial carrier: count=%d events=%d number=%d", beforeCount, createdEvents, beforeNumber)
	}

	// A stale caller still thinks the thread has no carrier. Bypass the handler
	// cache and exercise the service's locked recheck deterministically.
	params.Title = "Stale caller's proposed carrier"
	reused, err := svc.Create(t.Context(), params, opts)
	if err != nil {
		t.Fatal(err)
	}
	if reused.Issue.ID != first.Issue.ID || reused.Issue.Number != first.Issue.Number || reused.Issue.Title != first.Issue.Title {
		t.Errorf("stale caller created a different carrier: got %s, want %s", util.UUIDToString(reused.Issue.ID), bound)
	}
	if afterCount := f.Count(t, `SELECT count(*) FROM issue WHERE workspace_id=$1`, f.WorkspaceID); afterCount != beforeCount {
		t.Errorf("issue count changed: %d -> %d", beforeCount, afterCount)
	}
	f.QueryRow(t, `SELECT issue_counter FROM workspace WHERE id=$1`, f.WorkspaceID).Scan(&afterNumber)
	if afterNumber != beforeNumber || createdEvents != 1 {
		t.Errorf("reuse allocated a number or broadcast: number=%d -> %d events=%d", beforeNumber, afterNumber, createdEvents)
	}
}
