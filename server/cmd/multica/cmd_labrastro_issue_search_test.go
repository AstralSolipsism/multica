package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// newLabrastroIssueSearchTestCmd is newIssueSearchTestCmd plus the two flags
// cmd_labrastro_issue_search.go registers on the real command.
func newLabrastroIssueSearchTestCmd() *cobra.Command {
	cmd := newIssueSearchTestCmd()
	cmd.Flags().Int("offset", 0, "")
	cmd.Flags().String("scope", "all", "")
	return cmd
}

func TestLabrastroIssueSearchSendsExpectedParams(t *testing.T) {
	chdirWithDaemonTaskMarker(t)
	const projectUUID = "33333333-3333-4333-8333-333333333333"
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/issues/search" {
			t.Fatalf("path = %q, want /api/issues/search", r.URL.Path)
		}
		gotQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issues":   []any{},
			"has_more": true,
		})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_test-token")

	cmd := newLabrastroIssueSearchTestCmd()
	_ = cmd.Flags().Set("project", projectUUID)
	_ = cmd.Flags().Set("scope", "title_desc")
	_ = cmd.Flags().Set("include-closed", "true")
	_ = cmd.Flags().Set("limit", "5")
	_ = cmd.Flags().Set("offset", "10")
	stderr := captureStderr(t)
	defer stderr.restore()
	out, err := captureStdout(t, func() error {
		return labrastroRunIssueSearch(cmd, []string{"needle"})
	})
	if err != nil {
		t.Fatalf("labrastroRunIssueSearch: %v", err)
	}

	if gotQuery.Get("q") != "needle" {
		t.Fatalf("q = %q", gotQuery.Get("q"))
	}
	if gotQuery.Get("include_closed") != "true" {
		t.Fatalf("include_closed = %q, want true when --include-closed is set", gotQuery.Get("include_closed"))
	}
	if gotQuery.Get("project_id") != projectUUID {
		t.Fatalf("project_id = %q", gotQuery.Get("project_id"))
	}
	if gotQuery.Get("scope") != "title_desc" {
		t.Fatalf("scope = %q", gotQuery.Get("scope"))
	}
	if gotQuery.Get("limit") != "5" || gotQuery.Get("offset") != "10" {
		t.Fatalf("limit/offset = %q/%q", gotQuery.Get("limit"), gotQuery.Get("offset"))
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("decode stdout JSON: %v", err)
	}
	if payload["has_more"] != true {
		t.Fatalf("has_more = %#v, want true", payload["has_more"])
	}
	if _, ok := payload["issues"]; !ok {
		t.Fatalf("stdout JSON missing issues: %#v", payload)
	}
}

func TestLabrastroIssueSearchDefaultOmitsIncludeClosedAndScope(t *testing.T) {
	chdirWithDaemonTaskMarker(t)
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{"issues": []any{}, "has_more": false})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_test-token")

	cmd := newLabrastroIssueSearchTestCmd()
	// Default scope and default include-closed=false must not be sent explicitly.
	_ = cmd.Flags().Set("output", "table")
	if _, err := captureStdout(t, func() error {
		return labrastroRunIssueSearch(cmd, []string{"needle"})
	}); err != nil {
		t.Fatalf("labrastroRunIssueSearch: %v", err)
	}
	if gotQuery.Get("include_closed") != "" {
		t.Fatalf("include_closed = %q, want absent by default", gotQuery.Get("include_closed"))
	}
	if gotQuery.Get("scope") != "" {
		t.Fatalf("scope = %q, want absent for default all", gotQuery.Get("scope"))
	}
}

func TestLabrastroIssueSearchPreflight(t *testing.T) {
	for _, tc := range []struct {
		name, workspace, project, offset, want string
	}{
		{"missing workspace without project", "", "", "0", "workspace_id is required"},
		{"missing workspace with project", "", "44444444", "0", "workspace_id is required"},
		{"negative offset", "11111111-1111-4111-8111-111111111111", "", "-1", "--offset must be zero or greater"},
		{"negative offset before project resolution", "11111111-1111-4111-8111-111111111111", "44444444", "-1", "--offset must be zero or greater"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chdirWithDaemonTaskMarker(t)
			requests := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				_ = json.NewEncoder(w).Encode(map[string]any{"issues": []any{}, "projects": []any{}, "has_more": false})
			}))
			defer srv.Close()
			t.Setenv("MULTICA_SERVER_URL", srv.URL)
			t.Setenv("MULTICA_WORKSPACE_ID", tc.workspace)
			t.Setenv("MULTICA_TOKEN", "mat_test-token")
			cmd := newLabrastroIssueSearchTestCmd()
			_ = cmd.Flags().Set("project", tc.project)
			_ = cmd.Flags().Set("offset", tc.offset)
			_, err := captureStdout(t, func() error { return labrastroRunIssueSearch(cmd, []string{"needle"}) })
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want %q", err, tc.want)
			}
			if requests != 0 {
				t.Errorf("made %d requests before rejecting invalid input", requests)
			}
		})
	}
}

func TestLabrastroIssueSearchRejectsInvalidScope(t *testing.T) {
	chdirWithDaemonTaskMarker(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("server must not be called for an invalid scope")
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_test-token")

	cmd := newLabrastroIssueSearchTestCmd()
	_ = cmd.Flags().Set("scope", "bogus")
	if err := labrastroRunIssueSearch(cmd, []string{"needle"}); err == nil {
		t.Fatal("labrastroRunIssueSearch accepted an invalid --scope")
	}
}

// The server caps a search page at 50 even when a larger --limit is sent; the
// JSON envelope must echo the effective limit so offset += limit paging does
// not skip issues (OL-458 first review #4).
func TestLabrastroIssueSearchJSONEchoesEffectiveLimit(t *testing.T) {
	chdirWithDaemonTaskMarker(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The clamp happens before the request, so the wire carries the
		// effective page size, not the oversized request.
		if got := r.URL.Query().Get("limit"); got != "50" {
			t.Errorf("limit query = %q, want the effective 50", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"issues": []any{}, "has_more": true})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_test-token")

	cmd := newLabrastroIssueSearchTestCmd()
	_ = cmd.Flags().Set("limit", "100")
	out, err := captureStdout(t, func() error {
		return labrastroRunIssueSearch(cmd, []string{"needle"})
	})
	if err != nil {
		t.Fatalf("labrastroRunIssueSearch: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("decode stdout JSON: %v", err)
	}
	if got, ok := payload["limit"].(float64); !ok || int(got) != 50 {
		t.Fatalf("limit echo = %#v, want 50 (the server-side page cap)", payload["limit"])
	}
}

func TestLabrastroIssueSearchCommandRegistration(t *testing.T) {
	for _, name := range []string{"limit", "offset", "project", "scope", "include-closed", "output"} {
		if issueSearchCmd.Flags().Lookup(name) == nil {
			t.Errorf("issue search missing --%s", name)
		}
	}
	// Unwired, --scope and --offset would parse and then be silently ignored.
	if reflect.ValueOf(issueSearchCmd.RunE).Pointer() != reflect.ValueOf(labrastroRunIssueSearch).Pointer() {
		t.Fatal("issue search does not run labrastroRunIssueSearch")
	}
	if !strings.Contains(issueSearchCmd.Long, `"description" with --scope title_desc`) {
		t.Errorf("issue search help Long missing scope=title_desc match_source fallback description:\n%s", issueSearchCmd.Long)
	}
}
