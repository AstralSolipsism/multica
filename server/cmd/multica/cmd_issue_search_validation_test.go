package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunIssueSearchPreflight(t *testing.T) {
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
			cmd := newIssueSearchTestCmd()
			_ = cmd.Flags().Set("project", tc.project)
			_ = cmd.Flags().Set("offset", tc.offset)
			_, err := captureStdout(t, func() error { return runIssueSearch(cmd, []string{"needle"}) })
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %v, want %q", err, tc.want)
			}
			if requests != 0 {
				t.Errorf("made %d requests before rejecting invalid input", requests)
			}
		})
	}
}
