package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type engineeringFixture struct {
	t                    *testing.T
	project, agent, task string
}

func newEngineeringFixture(t *testing.T) engineeringFixture {
	t.Helper()
	f := engineeringFixture{t: t, project: dbfx.Project(t, "Engineering")}
	f.agent = dbfx.Agent(t, "Engineering agent "+uuid.NewString(), testRuntimeID)
	f.task = dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": testRuntimeID})
	dbfx.Cleanup(t, `DELETE FROM project_baseline_revision WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	dbfx.Cleanup(t, `DELETE FROM project_baseline_doc WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	dbfx.Cleanup(t, `DELETE FROM project_engineering WHERE workspace_id=$1 AND project_id=$2`, testWorkspaceID, f.project)
	return f
}
func (f engineeringFixture) request(method, path string, body any, credential string) *http.Request {
	req := newRequest(method, "/api/projects/"+f.project+path, body)
	req = withURLParam(req, "id", f.project)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)
	identity := auth.Identity{UserID: testUserID, CredentialKind: credential}
	switch credential {
	case "session":
		return req
	case "task":
		identity.WorkspaceID = testWorkspaceID
		identity.AgentID = f.agent
		identity.TaskID = f.task
		req.Header.Set("X-Actor-Source", "task_token")
	case "cloud_pat":
		req.Header.Set("X-Actor-Source", "cloud_pat")
	}
	return req.WithContext(auth.WithIdentity(req.Context(), identity))
}
func (f engineeringFixture) enable() {
	f.t.Helper()
	testutil.Call(f.t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"enabled": true}, "session")).Want(200)
}
func (f engineeringFixture) propose(chapter, content string, base, replaces *string) baselineRevisionResponse {
	f.t.Helper()
	var out baselineRevisionResponse
	testutil.Call(f.t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", map[string]any{"chapter": chapter, "content_markdown": content, "change_summary": "Change", "base_revision_id": base, "replaces_candidate_id": replaces}, "task")).Want(201).JSON(&out)
	return out
}
func decision(action string, revisions ...baselineRevisionResponse) any {
	items := []map[string]any{}
	for _, r := range revisions {
		items = append(items, map[string]any{"revision_id": uuidToString(r.ID), "expected_adopted_revision_id": uuidToPtr(r.BaseRevisionID)})
	}
	return map[string]any{"action": action, "revisions": items}
}
func wantEngineeringCode(t *testing.T, response *testutil.Response, code string) {
	t.Helper()
	var out struct {
		Code string `json:"code"`
	}
	response.JSON(&out)
	if out.Code != code {
		t.Fatalf("code=%q want %q", out.Code, code)
	}
}
func (f engineeringFixture) readRevision(id string) db.ProjectBaselineRevision {
	f.t.Helper()
	r, err := testHandler.Queries.LabrastroGetBaselineRevision(context.Background(), db.LabrastroGetBaselineRevisionParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project), ID: parseUUID(id)})
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

func TestLabrastroEngineeringDisabledAndRiskSeed(t *testing.T) {
	f := newEngineeringFixture(t)
	var out struct {
		Engineering db.ProjectEngineering     `json:"engineering"`
		Chapters    []baselineChapterResponse `json:"chapters"`
	}
	testutil.Call(t, testHandler.LabrastroGetEngineering, f.request("GET", "/engineering", nil, "session")).Want(200).JSON(&out)
	if out.Engineering.Enabled || out.Engineering.CurrentStage != 1 || len(out.Chapters) != 4 {
		t.Fatalf("defaults=%+v", out)
	}
	for _, c := range out.Chapters {
		if c.Adopted != nil || c.Candidate != nil {
			t.Fatal("unopened project has baseline")
		}
	}
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", map[string]any{"chapter": "overview", "content_markdown": "hi"}, "session")).Want(409), "engineering_disabled")
	f.enable()
	testutil.Call(t, testHandler.LabrastroGetEngineering, f.request("GET", "/engineering", nil, "session")).Want(200).JSON(&out)
	risk := out.Chapters[3].Adopted
	if risk == nil || risk.ContentMarkdown != baselinePATRisk || risk.DecisionCredential.String != "session" || risk.DecidedByID != parseUUID(testUserID) {
		t.Fatalf("risk=%+v", risk)
	}
	testutil.Call(t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"enabled": false}, "pat")).Want(200)
	f.enable()
	if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_revision WHERE project_id=$1`, f.project); n != 1 {
		t.Fatalf("risk reseeded: %d", n)
	}
}

func TestLabrastroEngineeringDecisionCredentialMatrix(t *testing.T) {
	for _, tt := range []struct {
		name, credential, action, code string
		red                            bool
		status                         int
	}{
		{name: "session", credential: "session", action: "adopt", status: 200},
		{name: "pat", credential: "pat", action: "adopt", status: 200},
		{name: "task", credential: "task", action: "adopt", status: 200},
		{name: "task rule warning", credential: "task", action: "adopt", red: true, status: 200},
		{name: "task reject rule warning", credential: "task", action: "reject", red: true, status: 200},
		{name: "cloud", credential: "cloud_pat", action: "adopt", status: 403, code: "baseline_credential_denied"},
		{name: "unknown", credential: "future", action: "adopt", status: 403, code: "baseline_credential_denied"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newEngineeringFixture(t)
			f.enable()
			var base *string
			content := "### [Rule-1] Rule\nMust always verify the full result."
			if tt.red {
				prior := f.propose("domain_rules", content, nil, nil)
				testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", prior), "session")).Want(200)
				base = uuidToPtr(prior.ID)
				content = ""
			}
			candidate := f.propose("domain_rules", content, base, nil)
			response := testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision(tt.action, candidate), tt.credential)).Want(tt.status)
			got := f.readRevision(uuidToString(candidate.ID))
			if tt.status != 200 {
				wantEngineeringCode(t, response, tt.code)
				if got.Status != "candidate" || got.DecidedByID.Valid {
					t.Fatal("denied operation mutated revision")
				}
				return
			}
			wantStatus := "adopted"
			if tt.action == "reject" {
				wantStatus = "rejected"
			}
			wantCredential := tt.credential
			if wantCredential == "task" {
				wantCredential = "agent_task"
			}
			if got.Status != wantStatus || got.DecisionCredential.String != wantCredential {
				t.Fatalf("audit=%+v", got)
			}
			if tt.credential == "task" {
				if got.DecidedByType.String != "agent" || got.DecidedByID != parseUUID(f.agent) || got.DecidedByTaskID != parseUUID(f.task) {
					t.Fatalf("wrong agent attribution: %+v", got)
				}
			} else if got.DecidedByType.String != "member" || got.DecidedByID != parseUUID(testUserID) || got.DecidedByTaskID.Valid {
				t.Fatalf("wrong member attribution: %+v", got)
			}
		})
	}
}

func TestLabrastroEngineeringConfigurationPermissions(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	member := dbfx.User(t, "Decider", uuid.NewString()+"@test.local")
	dbfx.Member(t, testWorkspaceID, member, "member")
	candidate := f.propose("overview", "### [Stage-1] First\nStart", nil, nil)
	req := f.request("POST", "/baseline/decisions", decision("adopt", candidate), "session")
	req.Header.Set("X-User-ID", member)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroDecideBaseline, req).Want(403), "baseline_not_decider")
	testutil.Call(t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"decider_member_ids": []string{member}}, "session")).Want(200)
	for _, body := range []map[string]any{{"enabled": false}, {"decider_member_ids": []string{}}} {
		req := f.request("PATCH", "/engineering", body, "session")
		req.Header.Set("X-User-ID", member)
		testutil.Call(t, testHandler.LabrastroPatchEngineering, req).Want(403)
	}
	req = f.request("PATCH", "/engineering", map[string]any{"current_stage": 2, "mode_summary": "Iterate"}, "session")
	req.Header.Set("X-User-ID", member)
	testutil.Call(t, testHandler.LabrastroPatchEngineering, req).Want(200)
	req = f.request("POST", "/baseline/decisions", decision("adopt", candidate), "session")
	req.Header.Set("X-User-ID", member)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, req).Want(200)
	testutil.Call(t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"enabled": false}, "task")).Want(403)
	testutil.Call(t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"decider_member_ids": []string{uuid.NewString()}}, "session")).Want(422)
	// The owner keeps decision authority even when an explicit list is present.
	c := f.propose("architecture", "### [ADR-1] Decision\nUse PostgreSQL", nil, nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", c), "pat")).Want(200)
}

func TestLabrastroEngineeringTaskWarningsRemainAdvisory(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	initial := f.propose("domain_rules", "### [Rule-1] Keep\n一二三四五六七八九十\n### [Rule-2] Remove\nRequired", nil, nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", initial), "task")).Want(200)
	var risk string
	dbfx.QueryRow(t, `SELECT adopted_revision_id::text FROM project_baseline_doc WHERE project_id=$1 AND chapter='exclusions_and_risks'`, f.project).Scan(&risk)
	exclusions := f.propose("exclusions_and_risks", baselinePATRisk+"\n### [Defer-1] Later\nRule-1 deferred without a pool", &risk, nil)
	rules := f.propose("domain_rules", "### [Rule-1] Keep\n一二三", uuidToPtr(initial.ID), nil)
	wantWarnings := map[string][]engineering.Warning{
		"domain_rules":         {{Code: "rule_shrunk", Anchor: "Rule-1"}, {Code: "rule_removed", Anchor: "Rule-2"}, {Code: "rule_deferred", Anchor: "Rule-1"}},
		"exclusions_and_risks": {{Code: "defer_missing_pool", Anchor: "Defer-1"}},
	}
	for _, revision := range []baselineRevisionResponse{rules, exclusions} {
		var diff engineering.Diff
		if err := json.Unmarshal(revision.AnchorsDiff, &diff); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(diff.Warnings, wantWarnings[revision.Chapter]) || revision.Status != "candidate" || revision.DecidedByID.Valid {
			t.Fatalf("proposal must preserve warnings without adopting: %+v, %+v", revision, diff)
		}
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", rules, exclusions), "task")).Want(200)
	for _, candidate := range []baselineRevisionResponse{rules, exclusions} {
		got := f.readRevision(uuidToString(candidate.ID))
		var diff engineering.Diff
		if err := json.Unmarshal(got.AnchorsDiff, &diff); err != nil {
			t.Fatal(err)
		}
		if got.Status != "adopted" || got.DecisionCredential.String != "agent_task" || got.DecidedByID != parseUUID(f.agent) || got.DecidedByTaskID != parseUUID(f.task) || !reflect.DeepEqual(diff.Warnings, wantWarnings[candidate.Chapter]) {
			t.Fatalf("adoption lost audit or warnings: %+v", got)
		}
	}
}

func TestLabrastroEngineeringTaskIsolationAndCapabilitySwitch(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	candidate := f.propose("overview", "### [Stage-1] First", nil, nil)
	req := f.request("POST", "/baseline/decisions", decision("adopt", candidate), "task")
	identity, _ := auth.IdentityFromContext(req.Context())
	identity.WorkspaceID = uuid.NewString()
	req = req.WithContext(auth.WithIdentity(req.Context(), identity))
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroDecideBaseline, req).Want(403), "baseline_credential_denied")
	testutil.Call(t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"agent_decisions_enabled": true}, "session")).Want(400)
	testutil.Call(t, testHandler.LabrastroPatchEngineering, f.request("PATCH", "/engineering", map[string]any{"enabled": false}, "session")).Want(200)
	for _, credential := range []string{"session", "pat", "task"} {
		for _, action := range []string{"adopt", "reject"} {
			wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision(action, candidate), credential)).Want(409), "engineering_disabled")
		}
	}
	if got := f.readRevision(uuidToString(candidate.ID)); got.Status != "candidate" || got.DecidedByID.Valid {
		t.Fatal("denied decision changed the candidate")
	}
}

func TestLabrastroEngineeringCandidateCASAtomicDecisionAndHistory(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	first := f.propose("overview", "### [Stage-1] First\nOne", nil, nil)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", map[string]any{"chapter": "overview", "content_markdown": "Changed"}, "session")).Want(409), "baseline_candidate_open")
	second := f.propose("overview", "### [Stage-1] First\nTwo", nil, uuidToPtr(first.ID))
	if f.readRevision(uuidToString(first.ID)).Status != "withdrawn" || second.RevisionNumber != 2 {
		t.Fatal("replacement lost revision history")
	}
	architecture := f.propose("architecture", "### [ADR-1] Decision\nOne", nil, nil)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", architecture, first), "session")).Want(409), "baseline_candidate_closed")
	if f.readRevision(uuidToString(architecture.ID)).Status != "candidate" {
		t.Fatal("failed multi-chapter adopt partially committed")
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", second, architecture), "session")).Want(200)
	stale := uuidToString(first.ID)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", map[string]any{"chapter": "overview", "content_markdown": "old", "base_revision_id": stale}, "session")).Want(409), "baseline_base_stale")
	rollback := f.propose("overview", first.ContentMarkdown, uuidToPtr(second.ID), nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", rollback), "session")).Want(200)
	if f.readRevision(uuidToString(second.ID)).Status != "superseded" {
		t.Fatal("old adopted was not superseded")
	}
	var history struct {
		Revisions []baselineRevisionResponse `json:"revisions"`
		More      bool                       `json:"has_more"`
		Before    int                        `json:"next_before"`
	}
	testutil.Call(t, testHandler.LabrastroBaselineHistory, f.request("GET", "/baseline/revisions?chapter=overview&limit=2", nil, "session")).Want(200).JSON(&history)
	if len(history.Revisions) != 2 || history.Revisions[0].RevisionNumber != 3 || !history.More || history.Before != 2 {
		t.Fatalf("history=%+v", history)
	}
	testutil.Call(t, testHandler.LabrastroBaselineHistory, f.request("GET", "/baseline/revisions?chapter=overview&before=2", nil, "session")).Want(200).JSON(&history)
	if len(history.Revisions) != 1 || history.Revisions[0].RevisionNumber != 1 || history.More {
		t.Fatalf("last page=%+v", history)
	}
	var diff engineering.Diff
	testutil.Call(t, testHandler.LabrastroBaselineHistory, f.request("GET", "/baseline/revisions?chapter=overview&diff_from=1&diff_to=2", nil, "session")).Want(200).JSON(&diff)
	if len(diff.Modified) != 1 || diff.Modified[0].Before != "One" || diff.Modified[0].After != "Two" {
		t.Fatalf("diff=%+v", diff)
	}
}

func TestLabrastroEngineeringConcurrentProposals(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			testHandler.LabrastroProposeBaseline(w, f.request("POST", "/baseline/candidates", map[string]any{"chapter": "overview", "content_markdown": "### [Stage-1] First"}, "session"))
			results <- w.Code
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for code := range results {
		counts[code]++
	}
	if counts[201] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent results=%v", counts)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM project_baseline_revision WHERE project_id=$1 AND chapter='overview'`, f.project); n != 1 {
		t.Fatalf("created %d revisions", n)
	}
}

func TestLabrastroEngineeringDiffRecheckedAcrossChapters(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	initial := f.propose("domain_rules", "### [Rule-1] Required\nAlways verify", nil, nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", initial), "task")).Want(200)
	cut := f.propose("domain_rules", "", uuidToPtr(initial.ID), nil)
	var risk string
	dbfx.QueryRow(t, `SELECT adopted_revision_id::text FROM project_baseline_doc WHERE project_id=$1 AND chapter='exclusions_and_risks'`, f.project).Scan(&risk)
	f.propose("exclusions_and_risks", baselinePATRisk+"\n### [Defer-1] Later\nRule-1 goes to OL-1", &risk, nil)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", cut), "task")).Want(409), "baseline_base_stale")
	if f.readRevision(uuidToString(cut.ID)).Status != "candidate" {
		t.Fatal("changed diff was adopted")
	}
	cut = f.propose("domain_rules", "", uuidToPtr(initial.ID), uuidToPtr(cut.ID))
	var diff engineering.Diff
	if err := json.Unmarshal(cut.AnchorsDiff, &diff); err != nil {
		t.Fatal(err)
	}
	if len(diff.Warnings) != 2 || diff.Warnings[1].Code != "rule_deferred" {
		t.Fatalf("diff=%+v", diff)
	}
}

func TestLabrastroEngineeringDeferUsesCurrentWorkspacePrefix(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	var prefix, risk string
	dbfx.QueryRow(t, `SELECT issue_prefix FROM workspace WHERE id=$1`, testWorkspaceID).Scan(&prefix)
	dbfx.QueryRow(t, `SELECT adopted_revision_id::text FROM project_baseline_doc WHERE project_id=$1 AND chapter='exclusions_and_risks'`, f.project).Scan(&risk)
	dbfx.Cleanup(t, `UPDATE workspace SET issue_prefix=$2 WHERE id=$1`, testWorkspaceID, prefix)

	content := baselinePATRisk + "\n### [Defer-1] Later\n" + prefix + "-1097"
	first := f.propose("exclusions_and_risks", content, &risk, nil)
	var diff engineering.Diff
	if err := json.Unmarshal(first.AnchorsDiff, &diff); err != nil {
		t.Fatal(err)
	}
	if len(diff.Warnings) != 0 {
		t.Fatalf("workspace issue reference warned: %+v", diff.Warnings)
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", first), "session")).Want(200)
	candidate := f.propose("exclusions_and_risks", content+"\nADR-3", uuidToPtr(first.ID), nil)

	dbfx.Exec(t, `UPDATE workspace SET issue_prefix='RENAMED' WHERE id=$1`, testWorkspaceID)
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", candidate), "session")).Want(409), "baseline_base_stale")
	if f.readRevision(uuidToString(candidate.ID)).Status != "candidate" {
		t.Fatal("prefix change must leave the candidate undecided")
	}

	path := "/baseline/revisions?chapter=exclusions_and_risks&diff_from=" + strconv.Itoa(int(first.RevisionNumber)) + "&diff_to=" + strconv.Itoa(int(candidate.RevisionNumber))
	testutil.Call(t, testHandler.LabrastroBaselineHistory, f.request("GET", path, nil, "session")).Want(200).JSON(&diff)
	want := []engineering.Warning{{Code: "defer_missing_pool", Anchor: "Defer-1"}}
	if !reflect.DeepEqual(diff.Warnings, want) {
		t.Fatalf("historical diff must use current prefix: %+v", diff.Warnings)
	}

	replacement := f.propose("exclusions_and_risks", candidate.ContentMarkdown, uuidToPtr(first.ID), uuidToPtr(candidate.ID))
	if err := json.Unmarshal(replacement.AnchorsDiff, &diff); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(diff.Warnings, want) {
		t.Fatalf("replacement must retain missing-pool warning: %+v", diff.Warnings)
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", replacement), "session")).Want(200)
}

func TestLabrastroEngineeringOpenIssuesAndIsolation(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	dbfx.Insert(t, "issue_status", testutil.Cols{"workspace_id": testWorkspaceID, "key": "eng_discussion", "name": "Discuss", "category": "unstarted", "color": "#888888", "position": 99, "is_system": false})
	dbfx.Issue(t, "custom queued", testutil.Cols{"project_id": f.project, "status": "eng_discussion"})
	dbfx.Issue(t, "started", testutil.Cols{"project_id": f.project, "status": "in_review", "assignee_type": "agent", "assignee_id": f.agent})
	dbfx.Issue(t, "finished", testutil.Cols{"project_id": f.project, "status": "done"})
	other := dbfx.Project(t, "Other project")
	dbfx.Issue(t, "other project", testutil.Cols{"project_id": other})
	c := f.propose("overview", "### [Stage-1] First", nil, nil)
	var response struct {
		Open baselineOpenIssues `json:"open_issues"`
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", c), "session")).Want(200).JSON(&response)
	if len(response.Open.Queued) != 1 || len(response.Open.InFlight) != 1 || response.Open.Queued[0].Category != "unstarted" || response.Open.InFlight[0].AssigneeID == nil || *response.Open.InFlight[0].AssigneeID != f.agent {
		t.Fatalf("open=%+v", response)
	}
	req := f.request("GET", "/engineering", nil, "session")
	req.Header.Set("X-Workspace-ID", uuid.NewString())
	testutil.Call(t, testHandler.LabrastroGetEngineering, req).Want(404)
}

func TestLabrastroEngineeringDeleteProjectCleansOnlyItsRows(t *testing.T) {
	a, b := newEngineeringFixture(t), newEngineeringFixture(t)
	a.enable()
	b.enable()
	a.propose("overview", "### [Stage-1] First", nil, nil)
	testutil.Call(t, testHandler.DeleteProject, a.request("DELETE", "", nil, "session")).Want(204)
	for _, table := range []string{"project_engineering", "project_baseline_doc", "project_baseline_revision"} {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", a.project); n != 0 {
			t.Fatalf("%s retained %d rows", table, n)
		}
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", b.project); n == 0 {
			t.Fatalf("%s deleted other project", table)
		}
	}
}

func TestLabrastroEngineeringRejectsInvalidInputAndAuditFields(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	for _, body := range []any{
		map[string]any{"chapter": "overview", "content_markdown": "### [Rule-1] Wrong chapter"},
		map[string]any{"chapter": "overview", "content_markdown": strings.Repeat("x", 65537)},
	} {
		testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", body, "session")).Want(422)
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", map[string]any{"action": "adopt", "decided_by_id": testUserID}, "task")).Want(400)
}

func TestLabrastroEngineeringWorkspaceDeleteAndOpenListBound(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	for i := 0; i < 201; i++ {
		dbfx.Issue(t, "Queued", testutil.Cols{"project_id": f.project})
	}
	c := f.propose("overview", "### [Stage-1] First", nil, nil)
	var response struct {
		Open baselineOpenIssues `json:"open_issues"`
	}
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", c), "session")).Want(200).JSON(&response)
	if len(response.Open.Queued) != 200 || !response.Open.Truncated {
		t.Fatalf("unbounded open issues: %d, %v", len(response.Open.Queued), response.Open.Truncated)
	}
	ws := dbfx.Workspace(t, "Engineering cleanup", "engineering-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	project := dbfx.Project(t, "Deleted project", testutil.Cols{"workspace_id": ws})
	req := newRequest("PATCH", "/api/projects/"+project+"/engineering", map[string]any{"enabled": true})
	req = withURLParam(req, "id", project)
	req.Header.Set("X-Workspace-ID", ws)
	testutil.Call(t, testHandler.LabrastroPatchEngineering, req).Want(200)
	for _, table := range []string{"project_engineering", "project_baseline_doc", "project_baseline_revision"} {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws); n != 1 {
			t.Fatalf("fixture %s: %d", table, n)
		}
	}
	req = newRequest("DELETE", "/api/workspaces/"+ws, nil)
	req = withURLParam(req, "id", ws)
	req.Header.Set("X-Workspace-ID", ws)
	testutil.Call(t, testHandler.DeleteWorkspace, req).Want(204)
	for _, table := range []string{"project_engineering", "project_baseline_doc", "project_baseline_revision"} {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws); n != 0 {
			t.Fatalf("workspace left %s: %d", table, n)
		}
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", f.project); n == 0 {
			t.Fatalf("workspace cleanup deleted unrelated %s", table)
		}
	}
}

func TestLabrastroEngineeringDefaultLeadAndConcurrentDecision(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	lead := dbfx.User(t, "Lead", uuid.NewString()+"@test.local")
	dbfx.Member(t, testWorkspaceID, lead, "member")
	dbfx.Exec(t, `UPDATE project SET lead_type='member',lead_id=$2 WHERE id=$1`, f.project, lead)
	candidate := f.propose("overview", "### [Stage-1] First", nil, nil)
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := f.request("POST", "/baseline/decisions", decision("adopt", candidate), "session")
			req.Header.Set("X-User-ID", lead)
			w := httptest.NewRecorder()
			testHandler.LabrastroDecideBaseline(w, req)
			results <- w.Code
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for code := range results {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("decision results=%v", counts)
	}
	if got := f.readRevision(uuidToString(candidate.ID)); got.DecidedByID != parseUUID(lead) || got.DecidedByType.String != "member" {
		t.Fatalf("lead audit=%+v", got)
	}
}

func TestLabrastroEngineeringProposalWaitsForProjectDelete(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := testHandler.Queries.WithTx(tx)
	if _, err = q.LockProjectForDelete(ctx, db.LockProjectForDeleteParams{WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(f.project)}); err != nil {
		t.Fatal(err)
	}
	if err = q.LabrastroDeleteProjectEngineering(ctx, db.LabrastroDeleteProjectEngineeringParams{WorkspaceID: parseUUID(testWorkspaceID), ProjectID: parseUUID(f.project)}); err != nil {
		t.Fatal(err)
	}
	req := f.request("POST", "/baseline/candidates", map[string]any{"chapter": "overview", "content_markdown": "### [Stage-1] First"}, "task")
	reqCtx, cancel := context.WithTimeout(req.Context(), 15*time.Second)
	defer cancel()
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); testHandler.LabrastroProposeBaseline(response, req.WithContext(reqCtx)) }()
	defer func() { tx.Rollback(context.Background()); cancel(); <-done }()
	if !waitForWaiterBlockedBy(t, holderBackendPID(t, ctx, tx), 10*time.Second) {
		t.Fatal("proposal did not wait for project deletion")
	}
	if err = q.DeleteProject(ctx, db.DeleteProjectParams{WorkspaceID: parseUUID(testWorkspaceID), ID: parseUUID(f.project)}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		if response.Code != 404 {
			t.Fatalf("proposal after delete: %d %s", response.Code, response.Body.String())
		}
	case <-reqCtx.Done():
		t.Fatal("proposal did not finish after deletion")
	}

	for _, table := range []string{"project_engineering", "project_baseline_doc", "project_baseline_revision"} {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", f.project); n != 0 {
			t.Fatalf("concurrent deletion left %s: %d", table, n)
		}
	}
}
