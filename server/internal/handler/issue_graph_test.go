package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func graphRequest(fx *testutil.Fixture, params url.Values) *http.Request {
	r := withURLParam(newRequest(http.MethodGet, "/api/workspaces/"+fx.WorkspaceID+"/issues/graph?"+params.Encode(), nil), "workspaceId", fx.WorkspaceID)
	r.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	return r
}

func readGraph(t *testing.T, h *Handler, fx *testutil.Fixture, params url.Values) service.IssueGraph {
	t.Helper()
	var g service.IssueGraph
	testutil.Call(t, h.GetIssueGraph, graphRequest(fx, params)).Want(http.StatusOK).JSON(&g)
	return g
}

func graphFilter(filters map[string]any) url.Values {
	b, _ := json.Marshal(map[string]any{"scope": map[string]string{"kind": "workspace"}, "filters": filters})
	return url.Values{"query": {string(b)}}
}

func graphNodes(g service.IssueGraph) map[string]service.IssueGraphNode {
	m := make(map[string]service.IssueGraphNode)
	for _, n := range g.Nodes {
		m[n.ID] = n
	}
	return m
}

func referenceGraph(t *testing.T, fx *testutil.Fixture) (map[string]string, map[string]string) {
	t.Helper()
	data, err := os.ReadFile("testdata/issue-graph/reference.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Projects []struct{ ID, Name string }
		Nodes    []struct {
			ID, Title, Status string
			ProjectID         string `json:"project_id"`
			ParentID          string `json:"parent_issue_id"`
			Stage             *int
		}
		Dependencies []struct {
			ID          string
			IssueID     string `json:"issue_id"`
			DependsOnID string `json:"depends_on_issue_id"`
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	ids, edges := map[string]string{}, map[string]string{}
	for _, p := range fixture.Projects {
		ids[p.ID] = fx.Project(t, p.Name)
	}
	for _, n := range fixture.Nodes {
		cols := testutil.Cols{"status": n.Status, "start_date": nil, "due_date": nil}
		if n.ProjectID != "" {
			cols["project_id"] = ids[n.ProjectID]
		}
		if n.ParentID != "" {
			cols["parent_issue_id"] = ids[n.ParentID]
		}
		if n.Stage != nil {
			cols["stage"] = *n.Stage
		}
		ids[n.ID] = fx.Issue(t, n.Title, cols)
	}
	for _, e := range fixture.Dependencies {
		edges[e.ID] = fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": ids[e.IssueID], "depends_on_issue_id": ids[e.DependsOnID], "type": "blocked_by"})
	}
	return ids, edges
}

func TestIssueGraphReferenceCompleteAndProjectContext(t *testing.T) {
	h, fx := dependencyFixture(t)
	ids, edges := referenceGraph(t, fx)
	g := readGraph(t, h, fx, nil)
	if path := os.Getenv("ISSUE_GRAPH_MOCK_PATH"); path != "" {
		data, err := json.MarshalIndent(g, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if !g.Complete || g.MatchedCount != 14 || g.ContextCount != 0 || len(g.Nodes) != 14 || len(g.Edges) != 7 || len(g.Projects) != 2 {
		t.Fatalf("incomplete reference graph: %+v", g)
	}
	var actual []string
	for _, e := range g.Edges {
		actual = append(actual, e.SourceEdgeID)
	}
	var expected []string
	for _, id := range edges {
		expected = append(expected, id)
	}
	sort.Strings(actual)
	sort.Strings(expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("graph differs from the stored edge ID set")
	}
	nodes := graphNodes(g)
	for name, id := range ids {
		if name != "P1" && name != "P2" && nodes[id].ID != id {
			t.Fatalf("missing database node %s", name)
		}
	}
	expectedEndpoints := map[string][2]string{
		edges["E1"]: {ids["U"], ids["A_MODEL"]}, edges["E2"]: {ids["A_MODEL"], ids["A_API"]},
		edges["E3"]: {ids["FAUTH"], ids["FCHECKOUT"]}, edges["E4"]: {ids["A_API"], ids["B_API"]},
		edges["E5"]: {ids["B_MODEL"], ids["B_API"]}, edges["E6"]: {ids["B_API"], ids["B_UI"]},
		edges["E7"]: {ids["B_REPORT"], ids["A_UI"]},
	}
	for _, e := range g.Edges {
		if expectedEndpoints[e.SourceEdgeID] != [2]string{e.Source, e.Target} {
			t.Fatal("graph edge endpoints disagree with the stored prerequisite direction")
		}
	}
	if nodes[ids["UNDATED"]].ProjectID != nil || nodes[ids["U"]].Title == "" {
		t.Fatal("unprojected/undated nodes were omitted")
	}
	if nodes[ids["B_API"]].DependencySummary.VisibleUnsatisfiedCount != 2 || nodes[ids["A_TEST"]].DependencySummary.VisibleUnsatisfiedCount != 0 {
		t.Fatal("direct/inherited readiness differs from OL-38")
	}
	if nodes[ids["FA"]].RunSummary.Running != 0 {
		t.Fatal("in_progress was mistaken for a real run")
	}
	for _, n := range g.Nodes {
		if n.DependencySummary.DependencyVersion != dependencies(t, h, fx, n.ID).DependencyVersion {
			t.Fatal("graph and dependency detail use different versions")
		}
	}
	project := readGraph(t, h, fx, url.Values{"project_id": {ids["P2"]}})
	if project.MatchedCount != 6 || project.ContextCount != 5 || len(project.Edges) != 6 {
		t.Fatalf("incorrect project closure: %+v", project)
	}
	pnodes := graphNodes(project)
	for _, key := range []string{"FA", "FAUTH", "A_API", "A_MODEL", "U"} {
		if pnodes[ids[key]].Role != "context" {
			t.Fatalf("missing external prerequisite/ancestor %s", key)
		}
	}
	if _, exists := pnodes[ids["A_UI"]]; exists {
		t.Fatal("unrelated downstream task leaked into the prerequisite closure")
	}
	params := graphFilter(map[string]any{"statuses": []string{"backlog"}})
	params.Set("focus_issue_id", ids["B_API"])
	focus := readGraph(t, h, fx, params)
	if focus.MatchedCount != 1 || graphNodes(focus)[ids["FAUTH"]].Role != "context" {
		t.Fatal("focus lost inherited prerequisite context")
	}
	params.Set("focus_issue_id", ids["A_API"])
	filteredFocus := readGraph(t, h, fx, params)
	if filteredFocus.MatchedCount != 0 || graphNodes(filteredFocus)[ids["A_API"]].Role != "context" {
		t.Fatal("locating a filtered task must not inflate matched_count")
	}
}

func TestIssueGraphFiltersUseSharedSurfaceSemantics(t *testing.T) {
	h, fx := dependencyFixture(t)
	ids, _ := referenceGraph(t, fx)
	for _, tc := range []struct {
		filters map[string]any
		count   int
	}{
		{map[string]any{"statuses": []string{"done"}}, 4},
		{map[string]any{"include_no_project": true}, 2},
		{map[string]any{"assignees": []any{}}, 0},
		{map[string]any{"working_issue_ids": []string{}}, 0},
		{map[string]any{"include_sub_issues": false}, 4},
		{map[string]any{"project_ids": []string{ids["P1"]}, "include_no_project": true}, 8},
		{map[string]any{"date": map[string]string{"field": "created_at", "start": "2000-01-01T00:00:00Z", "end": "2001-01-01T00:00:00Z"}}, 0},
	} {
		g := readGraph(t, h, fx, graphFilter(tc.filters))
		if g.MatchedCount != tc.count {
			t.Fatalf("filters=%v: matched %d, want %d", tc.filters, g.MatchedCount, tc.count)
		}
	}
	for _, params := range []url.Values{{"limit": {"1"}}, {"scheduled": {"true"}}, {"project_id": {"broken"}}, {"query": {"null"}}, {"query": {`{"filters":{"unknown":true}}`}}} {
		testutil.Call(t, h.GetIssueGraph, graphRequest(fx, params)).Want(http.StatusBadRequest)
	}
}

func TestIssueGraphRunsAndContentVersions(t *testing.T) {
	h, fx := dependencyFixture(t)
	id := fx.Issue(t, "Active", testutil.Cols{"status": "in_progress"})
	before := readGraph(t, h, fx, nil)
	runtimeID := fx.Runtime(t, "Graph fake runtime")
	agent := fx.Agent(t, "Graph fake agent", runtimeID)
	run := fx.Task(t, agent, testutil.Cols{"issue_id": id, "status": "queued", "runtime_id": runtimeID})
	queued := readGraph(t, h, fx, nil)
	if queued.Nodes[0].RunSummary.Queued != 1 || queued.Nodes[0].RunSummary.Running != 0 || queued.TopologyID != before.TopologyID || queued.SnapshotID == before.SnapshotID {
		t.Fatal("queue facts or content/topology versions are wrong")
	}
	fx.Exec(t, "UPDATE agent_task_queue SET status='running' WHERE id=$1", run)
	running := readGraph(t, h, fx, nil)
	if running.Nodes[0].RunSummary.Running != 1 || running.Nodes[0].RunSummary.Queued != 0 {
		t.Fatal("run transition was not observed")
	}
	for _, status := range []string{"dispatched", "waiting_local_directory"} {
		fx.Exec(t, "UPDATE agent_task_queue SET status=$2 WHERE id=$1", run, status)
		summary := readGraph(t, h, fx, nil).Nodes[0].RunSummary
		if summary.Running != 0 || summary.Queued != 0 || summary.Dispatched+summary.WaitingLocalDirectory != 1 {
			t.Fatal("active task state was omitted")
		}
	}
	fx.Exec(t, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", run)
	completed := readGraph(t, h, fx, nil)
	if completed.Nodes[0].Status != "in_progress" || completed.Nodes[0].RunSummary.Running != 0 {
		t.Fatal("run completion must not change Issue completion")
	}
	if completed.SnapshotID != before.SnapshotID {
		t.Fatal("collection time alone changed content identity")
	}
}

type graphTestStarter struct {
	inner       txStarter
	beforeQuery func(string) error
	commitError bool
	queryCount  *int
}

func (s graphTestStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.inner.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &graphTestTx{Tx: tx, beforeQuery: s.beforeQuery, commitError: s.commitError, queryCount: s.queryCount}, nil
}

type graphTestTx struct {
	pgx.Tx
	beforeQuery func(string) error
	commitError bool
	queryCount  *int
}

func (tx *graphTestTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if tx.queryCount != nil {
		*tx.queryCount++
	}
	if tx.beforeQuery != nil {
		if err := tx.beforeQuery(sql); err != nil {
			return nil, err
		}
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func (tx *graphTestTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if tx.queryCount != nil {
		*tx.queryCount++
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func (tx *graphTestTx) Commit(ctx context.Context) error {
	if tx.commitError {
		return errors.New("test commit failure")
	}
	return tx.Tx.Commit(ctx)
}

func TestIssueGraphRepeatableReadDuringEdits(t *testing.T) {
	h, fx := dependencyFixture(t)
	ids, edges := referenceGraph(t, fx)
	before := readGraph(t, h, fx, nil)
	interleaved := *h
	changed := false
	interleaved.TxStarter = graphTestStarter{inner: h.TxStarter, beforeQuery: func(sql string) error {
		if !changed && strings.Contains(sql, "ListIssueDependencyNodes") {
			changed = true
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1,parent_issue_id=NULL,project_id=NULL WHERE id=$1", ids["FAUTH"])
			fx.Exec(t, "DELETE FROM issue_dependency WHERE id=$1", edges["E3"])
			fx.Exec(t, "UPDATE project SET title='Changed project' WHERE id=$1", ids["P1"])
		}
		return nil
	}}
	during := readGraph(t, &interleaved, fx, nil)
	if !changed || before.SnapshotID != during.SnapshotID {
		t.Fatal("response mixed topology/state/project data from different snapshots")
	}
	after := readGraph(t, h, fx, nil)
	if after.SnapshotID == before.SnapshotID || len(after.Edges) != 6 || graphNodes(after)[ids["B_API"]].DependencySummary.VisibleUnsatisfiedCount != 1 {
		t.Fatal("subsequent snapshot did not observe committed edits")
	}
}

func TestIssueGraphWorkspaceIsolationAndInvalidReferences(t *testing.T) {
	h, fx := dependencyFixture(t)
	id := fx.Issue(t, "Local")
	_, foreign := dependencyFixture(t)
	other := foreign.Issue(t, "Private foreign title")
	project := foreign.Project(t, "Private foreign project")
	for _, params := range []url.Values{{"focus_issue_id": {other}}, {"project_id": {project}}} {
		r := testutil.Call(t, h.GetIssueGraph, graphRequest(fx, params)).Want(http.StatusNotFound)
		if strings.Contains(r.Body.String(), "Private") || strings.Contains(r.Body.String(), other) {
			t.Fatal("foreign reference disclosed")
		}
	}
	r := graphRequest(foreign, nil)
	r.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	testutil.Call(t, h.GetIssueGraph, r).Want(http.StatusNotFound)
	fx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", foreign.WorkspaceID, fx.UserID)
	testutil.Call(t, h.GetIssueGraph, graphRequest(foreign, nil)).Want(http.StatusNotFound)
	fx.Insert(t, "issue_dependency", testutil.Cols{"issue_id": id, "depends_on_issue_id": other, "type": "blocked_by"})
	res := testutil.Call(t, h.GetIssueGraph, graphRequest(fx, nil)).Want(http.StatusUnprocessableEntity)
	if strings.Contains(res.Body.String(), other) || strings.Contains(res.Body.String(), "Private") || strings.Contains(res.Body.String(), `"complete":true`) {
		t.Fatal("invalid graph leaked or claimed completeness")
	}
}

func TestIssueGraphLateFailuresNeverReturnPartialSuccess(t *testing.T) {
	h, fx := dependencyFixture(t)
	fx.Issue(t, "A")
	for _, commit := range []bool{false, true} {
		broken := *h
		broken.TxStarter = graphTestStarter{inner: h.TxStarter, commitError: commit, beforeQuery: func(sql string) error {
			if !commit && strings.Contains(sql, "ListIssueGraphRuns") {
				return errors.New("test late query failure")
			}
			return nil
		}}
		testutil.Call(t, broken.GetIssueGraph, graphRequest(fx, nil)).Want(http.StatusInternalServerError)
	}
	r := graphRequest(fx, nil)
	ctx, cancel := context.WithDeadline(r.Context(), time.Now().Add(-time.Second))
	defer cancel()
	testutil.Call(t, h.GetIssueGraph, r.WithContext(ctx)).Want(http.StatusGatewayTimeout)
}

func TestIssueGraphURLWorkspaceAndTaskBinding(t *testing.T) {
	h, fx := dependencyFixture(t)
	fx.Issue(t, "Visible from URL")
	router := chi.NewRouter()
	router.With(middleware.RequireWorkspaceMemberFromURL(h.Queries, "workspaceId")).
		Get("/api/workspaces/{workspaceId}/issues/graph", h.GetIssueGraph)
	request := func() *http.Request {
		r := newRequest(http.MethodGet, "/api/workspaces/"+fx.WorkspaceID+"/issues/graph", nil)
		r.Header.Del("X-Workspace-ID")
		return r
	}
	// URL-scoped reads need no redundant workspace header.
	testutil.Call(t, router.ServeHTTP, request()).Want(http.StatusOK)
	r := request()
	r.Header.Set("X-Actor-Source", "task_token")
	r.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	testutil.Call(t, router.ServeHTTP, r).Want(http.StatusOK)
	_, other := dependencyFixture(t)
	r.Header.Set("X-Workspace-ID", other.WorkspaceID)
	testutil.Call(t, router.ServeHTTP, r).Want(http.StatusForbidden)
}
