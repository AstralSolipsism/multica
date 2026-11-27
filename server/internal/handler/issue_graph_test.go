package handler

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// issueGraphFixture is an isolated workspace read through a copy of the
// shared handler.
func issueGraphFixture(t *testing.T) (*Handler, *testutil.Fixture) {
	t.Helper()
	ws := dbfx.Insert(t, "workspace", testutil.Cols{"name": "Issue graph tests", "slug": "issue-graph-" + strings.ReplaceAll(t.Name(), "/", "-") + "-" + time.Now().Format("150405.000000000"), "issue_prefix": "DEP"})
	dbfx.Insert(t, "member", testutil.Cols{"workspace_id": ws, "user_id": testUserID, "role": "owner"})
	h := *testHandler
	return &h, testutil.New(testPool, ws, testUserID)
}

// addBlocker stores one manual issue_blocker row the way the write API does.
func addBlocker(t *testing.T, fx *testutil.Fixture, issue, blocker string) {
	t.Helper()
	fx.InsertNoID(t, "issue_blocker", testutil.Cols{"workspace_id": fx.WorkspaceID, "issue_id": issue, "blocker_issue_id": blocker, "created_by_type": "member", "created_by_id": testUserID}, "issue_id=$1 AND blocker_issue_id=$2", issue, blocker)
}

// addWakeup stores one enabled event wakeup with a platform-evaluated
// condition, the way `--until-issue` does.
func addWakeup(t *testing.T, fx *testutil.Fixture, waiting string, condition map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(condition)
	fx.Exec(t, `INSERT INTO issue_wakeup(id,workspace_id,issue_id,instruction,kind,mode,condition)
 VALUES(gen_random_uuid(),$1,$2,'go','event','once',$3::jsonb)`, fx.WorkspaceID, waiting, raw)
}

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

// referenceGraph seeds the fixture and returns its logical IDs plus every
// effective blocker the graph must report, keyed by edge ID.
func referenceGraph(t *testing.T, fx *testutil.Fixture) (map[string]string, map[string]service.IssueGraphEdge) {
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
		Blockers []struct {
			IssueID   string `json:"issue_id"`
			BlockerID string `json:"blocker_issue_id"`
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	ids, expected := map[string]string{}, map[string]service.IssueGraphEdge{}
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
	for _, b := range fixture.Blockers {
		addBlocker(t, fx, ids[b.IssueID], ids[b.BlockerID])
		id := "manual:" + ids[b.IssueID] + ":" + ids[b.BlockerID]
		expected[id] = service.IssueGraphEdge{SourceEdgeID: id, Source: ids[b.BlockerID], Target: ids[b.IssueID], Type: "blocked_by"}
	}
	// Stage 3 waits for the stage 1 sibling; the stored edge to the stage 2
	// sibling replaces that pair's stage order.
	stage := "stage:" + ids["B_UI"] + ":" + ids["B_MODEL"]
	expected[stage] = service.IssueGraphEdge{SourceEdgeID: stage, Source: ids["B_MODEL"], Target: ids["B_UI"], Type: "blocked_by"}
	return ids, expected
}

func TestIssueGraphReferenceCompleteAndProjectContext(t *testing.T) {
	h, fx := issueGraphFixture(t)
	ids, expected := referenceGraph(t, fx)
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
	if !g.Complete || g.MatchedCount != 14 || g.ContextCount != 0 || len(g.Nodes) != 14 || len(g.Edges) != len(expected) || len(g.Projects) != 2 {
		t.Fatalf("incomplete reference graph: %+v", g)
	}
	got := map[string]service.IssueGraphEdge{}
	for _, e := range g.Edges {
		got[e.SourceEdgeID] = e
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("graph edges differ from the effective blockers:\n got %+v\nwant %+v", got, expected)
	}
	nodes := graphNodes(g)
	for name, id := range ids {
		if name != "P1" && name != "P2" && nodes[id].ID != id {
			t.Fatalf("missing database node %s", name)
		}
	}
	if nodes[ids["UNDATED"]].ProjectID != nil || nodes[ids["U"]].Title == "" {
		t.Fatal("unprojected/undated nodes were omitted")
	}
	for name, want := range map[string]int{"B_API": 1, "B_UI": 2, "FCHECKOUT": 1, "A_TEST": 0, "A_UI": 0, "A_MODEL": 0} {
		if got := nodes[ids[name]].DependencySummary; got.VisibleUnsatisfiedCount != want || got.HasRestrictedBlockers || got.DependencyVersion == "" {
			t.Fatalf("%s blocker summary = %+v, want %d open", name, got, want)
		}
	}
	if nodes[ids["FA"]].RunSummary.Running != 0 {
		t.Fatal("in_progress was mistaken for a real run")
	}
	project := readGraph(t, h, fx, url.Values{"project_id": {ids["P2"]}})
	if project.MatchedCount != 6 || project.ContextCount != 5 || len(project.Edges) != 7 {
		t.Fatalf("incorrect project closure: %+v", project)
	}
	pnodes := graphNodes(project)
	for _, key := range []string{"FA", "FAUTH", "A_MODEL", "A_API", "U"} {
		if pnodes[ids[key]].Role != "context" {
			t.Fatalf("missing external blocker/ancestor %s", key)
		}
	}
	if _, exists := pnodes[ids["A_UI"]]; exists {
		t.Fatal("unrelated downstream task leaked into the prerequisite closure")
	}
	params := graphFilter(map[string]any{"statuses": []string{"backlog"}})
	params.Set("focus_issue_id", ids["B_API"])
	focus := readGraph(t, h, fx, params)
	if focus.MatchedCount != 1 || graphNodes(focus)[ids["FAUTH"]].Role != "context" {
		t.Fatal("focus lost the transitive blocker context")
	}
	params.Set("focus_issue_id", ids["A_API"])
	filteredFocus := readGraph(t, h, fx, params)
	if filteredFocus.MatchedCount != 0 || graphNodes(filteredFocus)[ids["A_API"]].Role != "context" {
		t.Fatal("locating a filtered task must not inflate matched_count")
	}
}

func TestIssueGraphFiltersUseSharedSurfaceSemantics(t *testing.T) {
	h, fx := issueGraphFixture(t)
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
	h, fx := issueGraphFixture(t)
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
	h, fx := issueGraphFixture(t)
	ids, expected := referenceGraph(t, fx)
	before := readGraph(t, h, fx, nil)
	interleaved := *h
	changed := false
	interleaved.TxStarter = graphTestStarter{inner: h.TxStarter, beforeQuery: func(sql string) error {
		if !changed && strings.Contains(sql, "ListIssueGraphIssues") {
			changed = true
			fx.Exec(t, "UPDATE issue SET status='done',revision=revision+1,parent_issue_id=NULL,project_id=NULL WHERE id=$1", ids["FAUTH"])
			fx.Exec(t, "DELETE FROM issue_blocker WHERE issue_id=$1 AND blocker_issue_id=$2", ids["FCHECKOUT"], ids["FAUTH"])
			fx.Exec(t, "UPDATE project SET title='Changed project' WHERE id=$1", ids["P1"])
			fx.Exec(t, "UPDATE issue SET description=$2,revision=revision+1 WHERE id=$1", ids["B_API"], "see mention://issue/"+ids["A_API"])
		}
		return nil
	}}
	during := readGraph(t, &interleaved, fx, nil)
	if !changed || before.SnapshotID != during.SnapshotID {
		t.Fatal("response mixed topology/state/project data from different snapshots")
	}
	after := readGraph(t, h, fx, nil)
	if after.SnapshotID == before.SnapshotID || len(after.Edges) != len(expected)-1 || graphNodes(after)[ids["FAUTH"]].ParentIssueID != nil || len(after.WeakEdges) != 1 || after.WeakEdges[0] != (service.IssueGraphWeakEdge{From: ids["B_API"], To: ids["A_API"], Kind: "mention"}) {
		t.Fatal("subsequent snapshot did not observe committed edits")
	}
}

func TestIssueGraphWorkspaceIsolationAndInvalidReferences(t *testing.T) {
	h, fx := issueGraphFixture(t)
	id := fx.Issue(t, "Local")
	_, foreign := issueGraphFixture(t)
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
	// A blocker endpoint outside the workspace cannot be placed; the graph
	// refuses instead of dropping the edge and claiming completeness.
	fx.InsertNoID(t, "issue_blocker", testutil.Cols{"workspace_id": fx.WorkspaceID, "issue_id": id, "blocker_issue_id": other, "created_by_type": "member", "created_by_id": testUserID}, "issue_id=$1", id)
	res := testutil.Call(t, h.GetIssueGraph, graphRequest(fx, nil)).Want(http.StatusUnprocessableEntity)
	if strings.Contains(res.Body.String(), other) || strings.Contains(res.Body.String(), "Private") || strings.Contains(res.Body.String(), `"complete":true`) {
		t.Fatal("invalid graph leaked or claimed completeness")
	}
}

func TestIssueGraphLateFailuresNeverReturnPartialSuccess(t *testing.T) {
	h, fx := issueGraphFixture(t)
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
	h, fx := issueGraphFixture(t)
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
	_, other := issueGraphFixture(t)
	r.Header.Set("X-Workspace-ID", other.WorkspaceID)
	testutil.Call(t, router.ServeHTTP, r).Want(http.StatusForbidden)
}

// Wakeup waits and mention references are read with the blockers. Descriptions
// and live comments each count once per directed pair, either direction is
// legal, and none of it becomes a blocker.
func TestIssueGraphWeakEdgesFromWakeupsAndMentions(t *testing.T) {
	h, fx := issueGraphFixture(t)
	awaited, waiting, citing, cited := fx.Issue(t, "Awaited"), fx.Issue(t, "Waiting"), fx.Issue(t, "Citing"), fx.Issue(t, "Cited")
	mention := func(to string) string { return "see mention://issue/" + to }
	// One pair however it is written: again, in upper case, glued to a suffix
	// or right after an empty reference. A reference to itself never counts.
	description := strings.Join([]string{mention(cited), "see mention://issue/" + strings.ToUpper(cited), mention(citing),
		"mention://issue/mention://issue/" + cited, mention(cited) + "tail"}, " ")
	fx.Exec(t, "UPDATE issue SET description=$2 WHERE id=$1", citing, description)
	fx.Comment(t, citing, mention(cited))
	fx.Comment(t, cited, mention(awaited)+" then "+mention(citing))
	fx.Comment(t, citing, mention(awaited), testutil.Cols{"deleted_at": time.Now()})
	fx.Comment(t, citing, "dangling mention://issue/"+uuid.NewString())
	otherIssue := func(issueID, state string) map[string]any {
		return map[string]any{"type": "other_issue", "issue_id": issueID, "state": state}
	}
	addWakeup(t, fx, waiting, otherIssue(awaited, "in_review"))
	addWakeup(t, fx, waiting, otherIssue(awaited, "in_review"))
	addWakeup(t, fx, cited, map[string]any{"type": "other_issue", "issue_id": citing})
	// No edge from a disabled, platform-owned, self-watching, other-type or
	// malformed rule; the malformed one must not fail the whole read.
	fx.Exec(t, `INSERT INTO issue_wakeup(id,workspace_id,issue_id,instruction,kind,mode,enabled,system_rule,condition)
 VALUES(gen_random_uuid(),$1,$2,'go','event','once',false,NULL,jsonb_build_object('type','other_issue','issue_id',$3::text,'state','done')),
        (gen_random_uuid(),$1,$2,'go','event','once',true,'child_done',jsonb_build_object('type','other_issue','issue_id',$3::text)),
        (gen_random_uuid(),$1,$2,'go','event','once',true,NULL,jsonb_build_object('type','other_issue','issue_id',upper($2::text),'state','done')),
        (gen_random_uuid(),$1,$2,'go','event','once',true,NULL,jsonb_build_object('type','issue_field','field','status','value','"done"')),
        (gen_random_uuid(),$1,$2,'go','event','once',true,NULL,jsonb_build_object('type','other_issue','issue_id','not-a-uuid','state','done'))`,
		fx.WorkspaceID, waiting, awaited)
	want := map[service.IssueGraphWeakEdge]bool{
		{From: citing, To: cited, Kind: "mention"}:                            true,
		{From: cited, To: awaited, Kind: "mention"}:                           true,
		{From: cited, To: citing, Kind: "mention"}:                            true,
		{From: awaited, To: waiting, Kind: "wakeup", UntilState: "in_review"}: true,
		{From: citing, To: cited, Kind: "wakeup", UntilState: "done"}:         true,
	}
	g := readGraph(t, h, fx, nil)
	got := map[service.IssueGraphWeakEdge]bool{}
	for _, e := range g.WeakEdges {
		got[e] = true
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("weak edges:\n got %+v\nwant %+v", got, want)
	}
	if !slices.IsSortedFunc(g.WeakEdges, func(a, b service.IssueGraphWeakEdge) int {
		return cmp.Or(strings.Compare(a.Kind, b.Kind), strings.Compare(a.From, b.From), strings.Compare(a.To, b.To), strings.Compare(a.UntilState, b.UntilState))
	}) {
		t.Fatalf("weak edges are not ordered by kind and endpoints: %+v", g.WeakEdges)
	}
	if len(g.Edges) != 0 || g.MatchedCount != 4 || g.ContextCount != 0 || g.HasRestrictedContext {
		t.Fatalf("weak edges changed the blocker graph: %+v", g)
	}
	for _, n := range g.Nodes {
		if n.DependencySummary.VisibleUnsatisfiedCount != 0 || n.DependencySummary.HasRestrictedBlockers {
			t.Fatalf("%s: a weak edge was counted as a blocker", n.Title)
		}
	}
}
