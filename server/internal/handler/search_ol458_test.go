package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// OL-458: cross-issue search must be project-scopable, include done issues by
// default, page through offset/has_more, and be able to skip comment noise.

type searchIssuesPayload struct {
	Issues []struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		Status      string `json:"status"`
		MatchSource string `json:"match_source"`
	} `json:"issues"`
	HasMore bool `json:"has_more"`
}

func callIssueSearch(t *testing.T, rawQuery string) (*searchIssuesPayload, int) {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	recorder := httptest.NewRecorder()
	testHandler.SearchIssues(recorder, newRequest(http.MethodGet, "/api/issues/search?"+rawQuery, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("search status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var payload searchIssuesPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode search payload: %v", err)
	}
	return &payload, recorder.Code
}

func searchIDs(t *testing.T, payload *searchIssuesPayload) []string {
	t.Helper()
	ids := make([]string, 0, len(payload.Issues))
	for _, issue := range payload.Issues {
		ids = append(ids, issue.ID)
	}
	return ids
}

func TestIssueSearch_ProjectFilter(t *testing.T) {
	token := "projscope" + uuid.NewString()[:8]
	projectID := dbfx.Project(t, "Search project "+token)
	otherProjectID := dbfx.Project(t, "Other search project "+token)
	inProject := dbfx.Issue(t, token+" inside project", testutil.Cols{"project_id": projectID})
	dbfx.Issue(t, token+" other project", testutil.Cols{"project_id": otherProjectID})
	dbfx.Issue(t, token+" no project", testutil.Cols{"project_id": nil})

	payload, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&project_id="+projectID+"&include_closed=true&limit=50")
	got := searchIDs(t, payload)
	if len(got) != 1 || got[0] != inProject {
		t.Fatalf("project-filtered search = %v, want only %s", got, inProject)
	}
}

func TestIssueSearch_ProjectFilterRejectsMalformedUUID(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	recorder := httptest.NewRecorder()
	testHandler.SearchIssues(recorder, newRequest(http.MethodGet, "/api/issues/search?q=x&project_id=not-a-uuid", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}
}

func TestIssueSearch_HasMoreAndOffset(t *testing.T) {
	token := "pagemore" + uuid.NewString()[:8]
	first := dbfx.Issue(t, token+" one", testutil.Cols{})
	second := dbfx.Issue(t, token+" two", testutil.Cols{})

	payload, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&include_closed=true&limit=1")
	if len(payload.Issues) != 1 || !payload.HasMore {
		t.Fatalf("first page = %d issues, has_more=%t; want 1 issue with has_more=true", len(payload.Issues), payload.HasMore)
	}

	page2, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&include_closed=true&limit=1&offset=1")
	ids := searchIDs(t, page2)
	if len(ids) != 1 || (ids[0] != first && ids[0] != second) {
		t.Fatalf("second page = %v; want exactly one of [%s %s]", ids, first, second)
	}
	// The second page is exactly full and is the last one: has_more must be
	// false, or every full final page would send callers to an empty extra
	// page (OL-458 first review #3; mutation M01).
	if page2.HasMore {
		t.Fatalf("second page has_more=true; want false on the exactly-full final page")
	}

	page3, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&include_closed=true&limit=1&offset=2")
	if len(page3.Issues) != 0 || page3.HasMore {
		t.Fatalf("third page = %d issues, has_more=%t; want empty final page", len(page3.Issues), page3.HasMore)
	}
}

func TestIssueSearch_TitleDescScopeIgnoresComments(t *testing.T) {
	token := "titledesc" + uuid.NewString()[:8]
	titleHit := dbfx.Issue(t, token+" title carries it", testutil.Cols{})
	commentOnly := dbfx.Issue(t, "unrelated sibling issue", testutil.Cols{})
	dbfx.Comment(t, commentOnly, "the needle "+token+" only lives in this comment", testutil.Cols{})

	payload, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&scope=title_desc&include_closed=true&limit=50")
	got := searchIDs(t, payload)
	if len(got) != 1 || got[0] != titleHit {
		t.Fatalf("title_desc search = %v, want only %s (comment-only match must drop)", got, titleHit)
	}

	all, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&include_closed=true&limit=50")
	if !searchOL458Contains(searchIDs(t, all), commentOnly) {
		t.Fatalf("default scope lost the comment-only match: %v", searchIDs(t, all))
	}
}

// Regression for the OL-458 first review #1: with multiple terms the
// eligibility WHERE used to reference cm.comment_term_N even though the
// comment CTE and LEFT JOIN are dropped under scope=title_desc, so every
// multi-term title_desc query failed with SQLSTATE 42P01 / HTTP 500.
func TestIssueSearch_TitleDescScopeMultiWordQueries(t *testing.T) {
	tokenA := "mwalpha" + uuid.NewString()[:8]
	tokenB := "mwbeta" + uuid.NewString()[:8]
	projectID := dbfx.Project(t, "Search project "+tokenA)
	inProject := dbfx.Issue(t, tokenA+" title and "+tokenB, testutil.Cols{"project_id": projectID})

	// English multi-word.
	payload, _ := callIssueSearch(t, "q="+url.QueryEscape(tokenA+" "+tokenB)+"&scope=title_desc&include_closed=true&limit=50")
	if got := searchIDs(t, payload); len(got) != 1 || got[0] != inProject {
		t.Fatalf("multi-word title_desc search = %v, want only %s", got, inProject)
	}

	// Chinese multi-word (issue #1 was also reported with CJK queries).
	cjk := dbfx.Issue(t, "多词检索"+tokenA+"边界用例", testutil.Cols{})
	cjkPayload, _ := callIssueSearch(t, "q="+url.QueryEscape("多词检索 "+tokenA)+"&scope=title_desc&include_closed=true&limit=50")
	if got := searchIDs(t, cjkPayload); len(got) != 1 || got[0] != cjk {
		t.Fatalf("chinese multi-word title_desc search = %v, want only %s", got, cjk)
	}

	// Multi-word combined with the project filter.
	projPayload, _ := callIssueSearch(t, "q="+url.QueryEscape(tokenA+" "+tokenB)+"&scope=title_desc&project_id="+projectID+"&include_closed=true&limit=50")
	if got := searchIDs(t, projPayload); len(got) != 1 || got[0] != inProject {
		t.Fatalf("multi-word + project title_desc search = %v, want only %s", got, inProject)
	}
}

// Regression for the OL-458 first review #2: under scope=title_desc a
// number-only hit must report match_source "number", not "description" (which
// would also attach a description snippet that does not contain the query).
func TestIssueSearch_TitleDescScopeNumberHitMatchSource(t *testing.T) {
	workspaceID := dbfx.Workspace(t, "Number hit title_desc", "numhit-"+uuid.NewString(), testutil.Cols{"issue_prefix": "NH"})
	dbfx.Member(t, workspaceID, testUserID, "owner")
	// Neither the title nor the description contains the query string; the
	// issue is only reachable through its number.
	numbered := dbfx.Issue(t, "unrelated numbered issue", testutil.Cols{
		"workspace_id": workspaceID,
		"number":       12,
		"description":  "a long description that never mentions the identifier",
	})

	for _, scope := range []string{"", "&scope=title_desc"} {
		path := fmt.Sprintf("/api/issues/search?q=NH-12&include_closed=true&limit=50%s", scope)
		req := newRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Workspace-ID", workspaceID)
		var response struct {
			Issues []SearchIssueResponse `json:"issues"`
		}
		testutil.Call(t, testHandler.SearchIssues, req).Want(http.StatusOK).JSON(&response)

		if len(response.Issues) != 1 || response.Issues[0].ID != numbered {
			t.Fatalf("scope %q search = %d issues, want only %s", scope, len(response.Issues), numbered)
		}
		want := "comment"
		if scope != "" {
			want = "number"
		}
		if response.Issues[0].MatchSource != want {
			t.Fatalf("scope %q match_source = %q, want %q", scope, response.Issues[0].MatchSource, want)
		}
		// A number-only hit must not carry a description snippet, since the
		// description does not contain the query.
		if scope != "" && response.Issues[0].MatchedDescriptionSnippet != nil {
			t.Fatalf("title_desc number hit attached a description snippet: %q", *response.Issues[0].MatchedDescriptionSnippet)
		}
	}
}

func TestIssueSearch_IncludeClosedBehaviorUnchanged(t *testing.T) {
	token := "donedefault" + uuid.NewString()[:8]
	done := dbfx.Issue(t, token+" finished", testutil.Cols{"status": "done"})
	dbfx.Issue(t, token+" still open", testutil.Cols{"status": "in_progress"})

	// include_closed=true (the CLI default after OL-458) must find the done issue.
	withClosed, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&include_closed=true&limit=50")
	if !searchOL458Contains(searchIDs(t, withClosed), done) {
		t.Fatalf("include_closed=true lost the done issue: %v", searchIDs(t, withClosed))
	}
	// Absent include_closed keeps excluding terminal statuses.
	withoutClosed, _ := callIssueSearch(t, "q="+url.QueryEscape(token)+"&limit=50")
	if searchOL458Contains(searchIDs(t, withoutClosed), done) {
		t.Fatalf("absent include_closed unexpectedly returned the done issue: %v", searchIDs(t, withoutClosed))
	}
}

func searchOL458Contains(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}
