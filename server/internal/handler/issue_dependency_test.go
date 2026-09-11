package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func dependencyFixture(t *testing.T) (*Handler, *testutil.Fixture) {
	t.Helper()
	ws := dbfx.Insert(t, "workspace", testutil.Cols{"name": "Dependency tests", "slug": "dependency-" + strings.ReplaceAll(t.Name(), "/", "-") + "-" + time.Now().Format("150405.000000000"), "issue_prefix": "DEP"})
	dbfx.Insert(t, "member", testutil.Cols{"workspace_id": ws, "user_id": testUserID, "role": "owner"})
	fx := testutil.New(testPool, ws, testUserID)
	h := *testHandler
	is := *h.IssueService
	ds := *is.Dependencies
	ds.WritesEnabled = true
	is.Dependencies = &ds
	h.IssueService = &is
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM issue_dependency_audit WHERE workspace_id=$1", ws) })
	return &h, fx
}

func dependencyIssue(t *testing.T, fx *testutil.Fixture, title string, cols ...testutil.Cols) string {
	t.Helper()
	id := fx.Issue(t, title, cols...)
	fx.Exec(t, "UPDATE workspace SET issue_counter=(SELECT max(number) FROM issue WHERE workspace_id=$1) WHERE id=$1", fx.WorkspaceID)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM issue_dependency WHERE issue_id=$1 OR depends_on_issue_id=$1", id) })
	return id
}

func dependencyRequest(fx *testutil.Fixture, method, id string, body any, kind string) *http.Request {
	r := withURLParam(newRequest(method, "/api/issues/"+id+"/with-dependencies", body), "id", id)
	r.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	return r.WithContext(auth.WithIdentity(r.Context(), auth.Identity{UserID: fx.UserID, CredentialKind: kind}))
}

func dependencies(t *testing.T, h *Handler, fx *testutil.Fixture, id string) service.DependencyView {
	t.Helper()
	var v service.DependencyView
	testutil.Call(t, h.GetIssueDependencies, dependencyRequest(fx, http.MethodGet, id, nil, "jwt")).Want(http.StatusOK).JSON(&v)
	return v
}

func replaceDependencies(t *testing.T, h *Handler, fx *testutil.Fixture, id string, refs []string, kind string, status int) *testutil.Response {
	t.Helper()
	v := dependencies(t, h, fx, id)
	return testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, id, map[string]any{"blocked_by": refs, "expected_dependency_version": v.DependencyVersion}, kind)).Want(status)
}

func TestDependencyMultiProjectReadWriteAndVersion(t *testing.T) {
	h, fx := dependencyFixture(t)
	p1 := fx.Project(t, "Accounts")
	p2 := fx.Project(t, "Orders")
	a := dependencyIssue(t, fx, "Account API", testutil.Cols{"project_id": p1})
	c := dependencyIssue(t, fx, "Order schema", testutil.Cols{"project_id": p2, "status": "done"})
	b := dependencyIssue(t, fx, "Checkout feature", testutil.Cols{"project_id": p2})
	child := dependencyIssue(t, fx, "Checkout child", testutil.Cols{"parent_issue_id": b, "project_id": p2})
	replaceDependencies(t, h, fx, b, []string{a, c, a}, "task", http.StatusOK)
	v := dependencies(t, h, fx, b)
	if len(v.BlockedBy) != 2 || len(v.Unsatisfied) != 1 || v.Unsatisfied[0].IssueID != a {
		t.Fatalf("incorrect multi-prerequisite result: %+v", v)
	}
	childView := dependencies(t, h, fx, child)
	if len(childView.BlockedBy) != 0 || len(childView.InheritedBlockedBy) != 2 || childView.InheritedBlockedBy[0].InheritedFrom[0] != b {
		t.Fatalf("missing inheritance: %+v", childView)
	}
	if got := dependencies(t, h, fx, a); len(got.Blocking) != 1 || got.Blocking[0].DescendantCount != 1 {
		t.Fatalf("missing downstream provenance: %+v", got)
	}
	var aNumber int
	fx.QueryRow(t, "SELECT number FROM issue WHERE id=$1", a).Scan(&aNumber)
	replaceDependencies(t, h, fx, b, []string{c, "DEP-" + strconv.Itoa(aNumber), a}, "task", http.StatusOK)
	if got := dependencies(t, h, fx, b).DependencyVersion; got != v.DependencyVersion {
		t.Fatal("idempotent replacement changed source IDs or revision")
	}
	fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1 WHERE id=$1", a)
	ready := dependencies(t, h, fx, b)
	if len(ready.Unsatisfied) != 0 || ready.DependencyVersion == v.DependencyVersion {
		t.Fatal("completion did not update readiness/version")
	}
	var failure map[string]any
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, b, map[string]any{"blocked_by": []string{}, "expected_dependency_version": v.DependencyVersion, "title": "must roll back"}, "jwt")).Want(http.StatusConflict).JSON(&failure)
	if failure["reason_code"] != "dependency_version_conflict" {
		t.Fatalf("wrong conflict: %v", failure)
	}
	row, err := h.Queries.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{ID: parseUUID(b), WorkspaceID: parseUUID(fx.WorkspaceID)})
	if err != nil || row.Title != "Checkout feature" {
		t.Fatal("version conflict partially updated the issue")
	}
	replaceDependencies(t, h, fx, b, []string{}, "task", http.StatusOK)
}

func TestDependencyD1UsesCurrentStatusAndExistingCategory(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	b := dependencyIssue(t, fx, "B")
	replaceDependencies(t, h, fx, b, []string{a}, "task", http.StatusOK)
	fx.Insert(t, "issue_status", testutil.Cols{"workspace_id": fx.WorkspaceID, "key": "custom_done", "name": "Custom done", "category": "done", "position": 10, "color": "#22c55e"})
	for _, tc := range []struct {
		status string
		ready  bool
	}{{"done", true}, {"in_review", false}, {"cancelled", false}, {"todo", false}, {"custom_done", true}, {"unknown_status", false}} {
		fx.Exec(t, "UPDATE issue SET status=$2,revision=revision+1 WHERE id=$1", a, tc.status)
		if got := len(dependencies(t, h, fx, b).Unsatisfied) == 0; got != tc.ready {
			t.Fatalf("%s ready=%v", tc.status, got)
		}
	}
}

func TestDependencyInheritedCycleAndReparentRollback(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	a1 := dependencyIssue(t, fx, "A1", testutil.Cols{"parent_issue_id": a})
	b := dependencyIssue(t, fx, "B")
	b1 := dependencyIssue(t, fx, "B1")
	replaceDependencies(t, h, fx, b, []string{a1}, "task", http.StatusOK)
	replaceDependencies(t, h, fx, a, []string{b1}, "task", http.StatusOK)
	var failure map[string]any
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b1, map[string]any{"parent_issue_id": b, "title": "must roll back"}, "jwt")).Want(http.StatusConflict).JSON(&failure)
	if failure["reason_code"] != "dependency_cycle" {
		t.Fatalf("wrong inherited-cycle diagnostic: %v", failure)
	}
	row, err := h.Queries.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{ID: parseUUID(b1), WorkspaceID: parseUUID(fx.WorkspaceID)})
	if err != nil || row.ParentIssueID.Valid || row.Title != "B1" {
		t.Fatal("reparent failure partially committed")
	}
	replaceDependencies(t, h, fx, a1, []string{a}, "jwt", http.StatusConflict)
	replaceDependencies(t, h, fx, b, []string{b}, "jwt", http.StatusConflict)
}

func TestDependencyMachineCannotWeakenOrDeleteConstraints(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	b := dependencyIssue(t, fx, "B")
	child := dependencyIssue(t, fx, "child", testutil.Cols{"parent_issue_id": b})
	replaceDependencies(t, h, fx, b, []string{a}, "task", http.StatusOK)
	for _, kind := range []string{"task", "pat", "cloud_pat", "", "unknown"} {
		replaceDependencies(t, h, fx, b, []string{}, kind, http.StatusForbidden)
		testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, child, map[string]any{"parent_issue_id": nil}, kind)).Want(http.StatusForbidden)
		testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, a, nil, kind)).Want(http.StatusForbidden)
		testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, b, nil, kind)).Want(http.StatusForbidden)
	}
	// A status write is still allowed by the original policy. No human-only
	// completion restriction may be smuggled in through dependency protection.
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, a, map[string]any{"status": "done"}, "task")).Want(http.StatusOK)
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, a, nil, "task")).Want(http.StatusNoContent)
	if len(dependencies(t, h, fx, b).BlockedBy) != 0 {
		t.Fatal("deletion did not clean relation rows")
	}
}

func TestDependencyConcurrentOppositeEdges(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	b := dependencyIssue(t, fx, "B")
	va := dependencies(t, h, fx, a).DependencyVersion
	vb := dependencies(t, h, fx, b).DependencyVersion
	start := make(chan struct{})
	codes := make(chan int, 2)
	bodies := make(chan string, 2)
	var wg sync.WaitGroup
	for _, x := range []struct{ id, other, version string }{{a, b, va}, {b, a, vb}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r := dependencyRequest(fx, http.MethodPatch, x.id, map[string]any{"blocked_by": []string{x.other}, "expected_dependency_version": x.version}, "task")
			w := testutil.Call(t, h.UpdateIssueWithDependencies, r)
			codes <- w.Code
			bodies <- w.Body.String()
		}()
	}
	close(start)
	wg.Wait()
	close(codes)
	close(bodies)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[http.StatusOK] != 1 || counts[http.StatusConflict] != 1 {
		var details []string
		for body := range bodies {
			details = append(details, body)
		}
		t.Fatalf("opposite edges must serialize: %v %v", counts, details)
	}
	if len(dependencies(t, h, fx, a).BlockedBy)+len(dependencies(t, h, fx, b).BlockedBy) != 1 {
		t.Fatal("concurrent writes created a cycle")
	}
}

func TestDependencyCreateAndAssignRollbackAndWriteGate(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	agent := fx.Agent(t, "Fake assignee", fx.Runtime(t, "Fake runtime"))
	payload := map[string]any{"title": "blocked creation", "status": "backlog", "assignee_type": "agent", "assignee_id": agent, "blocked_by": []string{a}}
	var out map[string]any
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", payload, "task")).Want(http.StatusConflict).JSON(&out)
	if out["reason_code"] != "dependency_unsatisfied" {
		t.Fatalf("wrong admission result %v", out)
	}
	var count int
	err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM issue WHERE workspace_id=$1 AND title=$2", fx.WorkspaceID, "blocked creation").Scan(&count)
	if err != nil || count != 0 {
		t.Fatal("rejected create left an issue")
	}
	delete(payload, "assignee_type")
	delete(payload, "assignee_id")
	var created IssueResponse
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", payload, "task")).Want(http.StatusCreated).JSON(&created)
	t.Cleanup(func() {
		fx.Exec(t, "DELETE FROM issue_dependency WHERE issue_id=$1", created.ID)
		fx.Exec(t, "DELETE FROM issue WHERE id=$1", created.ID)
	})
	if created.Dependencies == nil || len(created.Dependencies.Unsatisfied) != 1 {
		t.Fatal("planning create did not persist prerequisites")
	}
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, created.ID, map[string]any{"assignee_type": "agent", "assignee_id": agent, "suppress_run": true}, "task")).Want(http.StatusConflict)
	h.IssueService.Dependencies.WritesEnabled = false
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", payload, "jwt")).Want(http.StatusNotFound)
	testutil.Call(t, h.CreateIssue, dependencyRequest(fx, http.MethodPost, "", payload, "jwt")).Want(http.StatusBadRequest)
}

func TestDependencyReferencesAndMalformedRequests(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	other := dbfx.Issue(t, "outside workspace")
	version := dependencies(t, h, fx, a).DependencyVersion
	for _, refs := range []any{nil, "wrong", 12} {
		testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, a, map[string]any{"blocked_by": refs, "expected_dependency_version": version}, "jwt")).Want(http.StatusBadRequest)
	}
	for _, ref := range []string{other, "missing-999999"} {
		out := testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, a, map[string]any{"blocked_by": []string{ref}, "expected_dependency_version": version}, "jwt")).Want(http.StatusNotFound).Map()
		if out["reason_code"] != "not_found" {
			t.Fatalf("missing machine-readable reference failure: %v", out)
		}
	}
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, a, map[string]any{"blocked_by": []string{}}, "jwt")).Want(http.StatusBadRequest)
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": a, "depends_on_issue_id": other, "type": "blocks"})
	var result map[string]any
	testutil.Call(t, h.GetIssueDependencies, dependencyRequest(fx, http.MethodGet, a, nil, "jwt")).Want(http.StatusUnprocessableEntity).JSON(&result)
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), other) {
		t.Fatal("historical error leaked foreign endpoint")
	}
	testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, a, map[string]any{"title": "must roll back"}, "jwt")).Want(http.StatusUnprocessableEntity)
	var title string
	fx.QueryRow(t, "SELECT title FROM issue WHERE id=$1", a).Scan(&title)
	if title != "A" {
		t.Fatal("compound response validation did not roll back the issue write")
	}
}

func TestDependencySnapshotUUIDsRemainStable(t *testing.T) {
	w := newDependencyLoadWorkspace(t, 300, "sparse")
	for _, kind := range []string{"related", "blocks"} {
		w.fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": w.ids[0], "depends_on_issue_id": w.ids[299], "type": kind})
	}
	ctx := context.Background()
	ws := parseUUID(w.fx.WorkspaceID)
	snapshot, err := w.h.IssueService.Dependencies.Load(ctx, w.h.Queries, ws)
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := w.h.Queries.ListIssueDependencyNodes(ctx, ws)
	if err != nil || len(snapshot.Model.Issues) != len(nodes) {
		t.Fatalf("snapshot nodes: %v", err)
	}
	for _, n := range nodes {
		id := uuidToString(n.ID)
		if got := snapshot.Model.Issues[id]; got.ID != id || got.ParentID != uuidToString(n.ParentIssueID) {
			t.Fatal("snapshot UUID changed after loading later rows")
		}
	}
	// Read ordinary rows independently of the compact snapshot query.
	rows, err := testPool.Query(ctx, "SELECT d.id,d.issue_id,d.depends_on_issue_id,d.type FROM issue_dependency d JOIN issue i ON i.id=d.issue_id WHERE i.workspace_id=$1 ORDER BY d.id", ws)
	if err != nil {
		t.Fatalf("snapshot edges: %v", err)
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var e db.IssueDependency
		if err := rows.Scan(&e.ID, &e.IssueID, &e.DependsOnIssueID, &e.Type); err != nil {
			t.Fatal(err)
		}
		if i >= len(snapshot.Model.Edges) {
			t.Fatal("snapshot omitted an edge")
		}
		if got := snapshot.Model.Edges[i]; got.ID != uuidToString(e.ID) || got.IssueID != uuidToString(e.IssueID) || got.DependsOnID != uuidToString(e.DependsOnIssueID) || got.Type != e.Type {
			t.Fatal("snapshot edge columns lost alignment or changed after loading later rows")
		}
		i++
	}
	if err := rows.Err(); err != nil || i != len(snapshot.Model.Edges) {
		t.Fatalf("snapshot duplicated edges or query failed: %v", err)
	}
}

func TestDependencySnapshotRetainsIncidentEdges(t *testing.T) {
	for _, direction := range []string{"local", "outbound", "inbound"} {
		t.Run(direction, func(t *testing.T) {
			h, fx := dependencyFixture(t)
			local := dependencyIssue(t, fx, "local")
			source, target := local, dependencyIssue(t, fx, "prerequisite")
			switch direction {
			case "outbound":
				target = dbfx.Issue(t, "foreign")
			case "inbound":
				source, target = dbfx.Issue(t, "foreign"), local
			}
			edge := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": source, "depends_on_issue_id": target, "type": "blocked_by"})
			snapshot, err := h.IssueService.Dependencies.Load(context.Background(), h.Queries, parseUUID(fx.WorkspaceID))
			if err != nil {
				t.Fatal(err)
			}
			if len(snapshot.Model.Edges) != 1 || snapshot.Model.Edges[0].ID != edge || snapshot.Model.Edges[0].IssueID != source || snapshot.Model.Edges[0].DependsOnID != target {
				t.Fatalf("lost or duplicated incident edge: %+v", snapshot.Model.Edges)
			}
			if err := snapshot.Model.Validate(); (err == nil) != (direction == "local") {
				t.Fatalf("corrupt endpoint validation: %v", err)
			}
		})
	}
}

func TestDependencyCompoundCreateWithoutExplicitPrerequisites(t *testing.T) {
	h, fx := dependencyFixture(t)
	var created IssueResponse
	testutil.Call(t, h.CreateIssueWithDependencies, dependencyRequest(fx, http.MethodPost, "", map[string]any{"title": "planning without explicit edges", "status": "backlog"}, "task")).Want(http.StatusCreated).JSON(&created)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM issue WHERE id=$1", created.ID) })
	if created.Dependencies == nil || created.Dependencies.DependencyVersion == "" || len(created.Dependencies.Unsatisfied) != 0 {
		t.Fatalf("missing coherent empty dependency snapshot: %+v", created.Dependencies)
	}
}

func TestDependencyBatchAndDeleteFailureHaveNoSideEffects(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	b := dependencyIssue(t, fx, "B")
	child := dependencyIssue(t, fx, "child", testutil.Cols{"parent_issue_id": b})
	free := dependencyIssue(t, fx, "free")
	replaceDependencies(t, h, fx, b, []string{a}, "task", http.StatusOK)
	var batch struct {
		Updated int `json:"updated"`
		Results []struct {
			Updated    bool   `json:"updated"`
			ReasonCode string `json:"reason_code"`
		} `json:"results"`
	}
	testutil.Call(t, h.BatchUpdateIssues, dependencyRequest(fx, http.MethodPost, "", map[string]any{"issue_ids": []string{child, free}, "updates": map[string]any{"parent_issue_id": nil, "title": "renamed"}}, "task")).Want(http.StatusOK).JSON(&batch)
	if batch.Updated != 1 || len(batch.Results) != 2 || batch.Results[0].ReasonCode != "dependency_change_not_allowed" || !batch.Results[1].Updated {
		t.Fatalf("incorrect partial batch: %+v", batch)
	}
	row, err := h.Queries.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{ID: parseUUID(child), WorkspaceID: parseUUID(fx.WorkspaceID)})
	if err != nil || row.Title != "child" || uuidToString(row.ParentIssueID) != b {
		t.Fatal("blocked batch item was partially written")
	}
	runtime := fx.Runtime(t, "Fake runtime")
	agent := fx.Agent(t, "Fake agent", runtime)
	task := fx.Task(t, agent, testutil.Cols{"issue_id": a, "runtime_id": runtime, "status": "running"})
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, a, nil, "task")).Want(http.StatusForbidden)
	var status string
	if err := testPool.QueryRow(context.Background(), "SELECT status FROM agent_task_queue WHERE id=$1", task).Scan(&status); err != nil || status != "running" {
		t.Fatalf("rejected delete cancelled task: %s %v", status, err)
	}
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, a, nil, "jwt")).Want(http.StatusNoContent)
	var remaining int
	if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM agent_task_queue WHERE id=$1", task).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("accepted delete did not clean up the task through the existing cascade: %d %v", remaining, err)
	}
}

func TestDependencyDeepHierarchyAndTextOnlyEdit(t *testing.T) {
	h, fx := dependencyFixture(t)
	root := dependencyIssue(t, fx, "root")
	last := root
	for i := 0; i < 20; i++ {
		last = dependencyIssue(t, fx, "descendant", testutil.Cols{"parent_issue_id": last})
	}
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, root, map[string]any{"parent_issue_id": last}, "jwt")).Want(http.StatusConflict)
	// A plain title edit joins the structure queue but still avoids loading and
	// locking the full graph. Hold an unrelated row without the structure lock.
	tx, err := testPool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := h.Queries.WithTx(tx).LockIssueForDescriptionUpdate(context.Background(), db.LockIssueForDescriptionUpdateParams{ID: parseUUID(root), WorkspaceID: parseUUID(fx.WorkspaceID)}); err != nil {
		t.Fatal(err)
	}
	r := dependencyRequest(fx, http.MethodPut, last, map[string]any{"title": "edited without loading graph"}, "jwt")
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	testutil.Call(t, h.UpdateIssue, r.WithContext(ctx)).Want(http.StatusOK)
}

func TestDependencyAuditIsOwnedByWorkspaceDeletion(t *testing.T) {
	h, fx := dependencyFixture(t)
	a := dependencyIssue(t, fx, "A")
	b := dependencyIssue(t, fx, "B")
	replaceDependencies(t, h, fx, b, []string{a}, "task", http.StatusOK)
	var count int
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency_audit WHERE workspace_id=$1", fx.WorkspaceID).Scan(&count)
	if count != 1 {
		t.Fatal("relation mutation did not write an audit")
	}
	lockRollupSingleton(t)
	r := withURLParam(newRequest(http.MethodDelete, "/api/workspaces/"+fx.WorkspaceID, nil), "id", fx.WorkspaceID)
	testutil.Call(t, h.DeleteWorkspace, r).Want(http.StatusNoContent)
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency_audit WHERE workspace_id=$1", fx.WorkspaceID).Scan(&count)
	if count != 0 {
		t.Fatal("workspace deletion orphaned the dependency audit")
	}
}

func TestDependencyLegacyOperationsIgnoreUnrelatedUnverifiedData(t *testing.T) {
	for _, kind := range []string{"blocks", "related_foreign", "blocked_by_foreign", "canonical_cycle"} {
		t.Run(kind, func(t *testing.T) {
			h, fx := dependencyFixture(t)
			h.IssueService.Dependencies.WritesEnabled = false
			bad := dependencyIssue(t, fx, "historical relation")
			other := dependencyIssue(t, fx, "historical endpoint")
			edgeType := kind
			if strings.HasSuffix(kind, "_foreign") {
				edgeType = strings.TrimSuffix(kind, "_foreign")
				other = dbfx.Issue(t, "foreign historical endpoint")
			}
			if kind == "canonical_cycle" {
				edgeType = "blocked_by"
				fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": other, "depends_on_issue_id": bad, "type": edgeType})
			}
			edge := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": bad, "depends_on_issue_id": other, "type": edgeType})
			parent := dependencyIssue(t, fx, "unrelated parent")
			free := dependencyIssue(t, fx, "unrelated task", testutil.Cols{"status": "backlog"})
			agent := fx.Agent(t, "Fake assignee", fx.Runtime(t, "Fake runtime"))

			testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, free, map[string]any{"assignee_type": "agent", "assignee_id": agent, "suppress_run": true}, "task")).Want(http.StatusOK)
			testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, free, map[string]any{"parent_issue_id": parent}, "jwt")).Want(http.StatusOK)
			testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, free, map[string]any{"parent_issue_id": nil}, "task")).Want(http.StatusOK)
			var created IssueResponse
			testutil.Call(t, h.CreateIssue, dependencyRequest(fx, http.MethodPost, "", map[string]any{"title": "ordinary child", "parent_issue_id": parent, "status": "backlog", "assignee_type": "agent", "assignee_id": agent}, "task")).Want(http.StatusCreated).JSON(&created)
			t.Cleanup(func() { fx.Exec(t, "DELETE FROM issue WHERE id=$1", created.ID) })
			testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, free, nil, "task")).Want(http.StatusNoContent)
			testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, parent, nil, "jwt")).Want(http.StatusNoContent)
			var detached bool
			fx.QueryRow(t, "SELECT parent_issue_id IS NULL FROM issue WHERE id=$1", created.ID).Scan(&detached)
			if !detached {
				t.Fatal("ordinary parent deletion did not detach the surviving child")
			}

			// Legacy compatibility must not advertise a verified dependency view
			// or make the workspace eligible for explicit dependency writes.
			out := testutil.Call(t, h.GetIssueDependencies, dependencyRequest(fx, http.MethodGet, created.ID, nil, "jwt")).Want(http.StatusUnprocessableEntity).Map()
			if out["reason_code"] != "dependency_data_unverified" {
				t.Fatalf("unverified workspace appeared ready: %v", out)
			}
			testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, created.ID, map[string]any{"title": "must roll back"}, "jwt")).Want(http.StatusNotFound)
			h.IssueService.Dependencies.WritesEnabled = true
			testutil.Call(t, h.UpdateIssueWithDependencies, dependencyRequest(fx, http.MethodPatch, created.ID, map[string]any{"title": "must roll back"}, "jwt")).Want(http.StatusUnprocessableEntity)
			var title string
			fx.QueryRow(t, "SELECT title FROM issue WHERE id=$1", created.ID).Scan(&title)
			if title != "ordinary child" {
				t.Fatal("unverified compound write partially committed")
			}
			var unchanged bool
			fx.QueryRow(t, "SELECT issue_id=$2 AND depends_on_issue_id=$3 AND type=$4 FROM issue_dependency WHERE id=$1", edge, bad, other, edgeType).Scan(&unchanged)
			if !unchanged {
				t.Fatal("ordinary operations rewrote an unverified historical row")
			}
		})
	}
}

func TestDependencyLegacyOperationsStillProtectCanonicalConstraints(t *testing.T) {
	h, fx := dependencyFixture(t)
	h.IssueService.Dependencies.WritesEnabled = false
	a := dependencyIssue(t, fx, "prerequisite")
	b := dependencyIssue(t, fx, "dependent", testutil.Cols{"status": "backlog"})
	child := dependencyIssue(t, fx, "child", testutil.Cols{"parent_issue_id": b})
	parent := dependencyIssue(t, fx, "new parent")
	canonical := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": a, "type": "blocked_by"})
	unknown := fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": b, "depends_on_issue_id": parent, "type": "blocks"})
	agent := fx.Agent(t, "Fake assignee", fx.Runtime(t, "Fake runtime"))
	assignment := map[string]any{"assignee_type": "agent", "assignee_id": agent, "suppress_run": true}
	out := testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, assignment, "task")).Want(http.StatusConflict).Map()
	if out["reason_code"] != "dependency_unsatisfied" {
		t.Fatalf("unknown rows disabled canonical admission: %v", out)
	}
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, child, map[string]any{"parent_issue_id": nil}, "task")).Want(http.StatusForbidden)
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, a, nil, "task")).Want(http.StatusForbidden)
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, b, nil, "task")).Want(http.StatusForbidden)
	// The new parent is in a previously disconnected execution component.
	// Both components must be considered without interpreting the blocks row.
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"parent_issue_id": parent}, "jwt")).Want(http.StatusOK)
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, parent, map[string]any{"parent_issue_id": child}, "jwt")).Want(http.StatusConflict)
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, a, map[string]any{"parent_issue_id": child}, "jwt")).Want(http.StatusConflict)
	var retained int
	fx.QueryRow(t, "SELECT count(*) FROM issue_dependency WHERE id IN ($1,$2)", canonical, unknown).Scan(&retained)
	if retained != 2 {
		t.Fatal("reparent rewrote historical relations")
	}
	// Human preassignment and the existing completion policy still work.
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, assignment, "jwt")).Want(http.StatusOK)
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, a, map[string]any{"status": "done"}, "task")).Want(http.StatusOK)
	testutil.Call(t, h.UpdateIssue, dependencyRequest(fx, http.MethodPut, b, map[string]any{"status": "todo"}, "task")).Want(http.StatusOK)
	t.Cleanup(func() { fx.Exec(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", b) })

	foreign := dbfx.Issue(t, "foreign prerequisite")
	bad := dependencyIssue(t, fx, "invalid canonical reference")
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": bad, "depends_on_issue_id": foreign, "type": "blocked_by"})
	for _, request := range []*http.Request{
		dependencyRequest(fx, http.MethodPut, bad, assignment, "task"),
		dependencyRequest(fx, http.MethodPut, b, map[string]any{"parent_issue_id": bad}, "jwt"),
	} {
		out := testutil.Call(t, h.UpdateIssue, request).Want(http.StatusUnprocessableEntity).Map()
		encoded, _ := json.Marshal(out)
		if out["reason_code"] != "dependency_data_unverified" || strings.Contains(string(encoded), foreign) {
			t.Fatalf("affected invalid canonical data was ignored or disclosed: %v", out)
		}
	}
	testutil.Call(t, h.DeleteIssue, dependencyRequest(fx, http.MethodDelete, bad, nil, "jwt")).Want(http.StatusUnprocessableEntity)
}
