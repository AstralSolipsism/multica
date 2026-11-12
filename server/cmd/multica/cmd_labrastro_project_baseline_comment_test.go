package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestBaselineCommentCommands(t *testing.T) {
	body := "[@Agent](mention://agent/" + baselineTestIssueID + ") 中文正文\nsecond line"
	file := writeBaselineInput(t, body)
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, input map[string]any) {
		baselineWriteJSON(w, 200, map[string]any{"ok": true, "threads": []any{}, "woke": []any{map[string]any{"target_type": "agent", "target_id": baselineTestIssueID, "status": "blocked", "reason_code": "invocation_not_allowed"}}})
	})
	base := "/api/projects/" + baselineTestProject + "/baseline"
	for _, tc := range []struct {
		action, method, path string
		flags                []string
	}{
		{"list", "GET", "/pages/a/threads", []string{"--page", "a", "--state", "all"}},
		{"show", "GET", "/threads/" + baselineTestRevisionID, []string{"--thread", baselineTestRevisionID, "--with-section"}},
		{"create", "POST", "/pages/a/threads", []string{"--page", "a", "--quote", "原文", "--section", "规则", "--content-file", file}},
		{"reply", "POST", "/threads/" + baselineTestRevisionID + "/comments", []string{"--thread", baselineTestRevisionID, "--content-file", file}},
		{"edit", "PATCH", "/comments/" + baselineTestRevisionID, []string{"--comment", baselineTestRevisionID, "--content-file", file}},
		{"delete", "DELETE", "/comments/" + baselineTestRevisionID, []string{"--comment", baselineTestRevisionID}},
		{"resolve", "POST", "/threads/" + baselineTestRevisionID + "/resolve", []string{"--thread", baselineTestRevisionID}},
		{"reopen", "POST", "/threads/" + baselineTestRevisionID + "/resolve", []string{"--thread", baselineTestRevisionID}},
	} {
		t.Run(tc.action, func(t *testing.T) {
			args := append([]string{"comment", tc.action, baselineTestProject, "--output", "json"}, tc.flags...)
			out, stderr, code := executeBaseline(t, args...)
			if code != 0 {
				t.Fatalf("%d %s %s", code, stderr, out)
			}
			baselineJSON(t, out)
			all := calls()
			got := all[len(all)-1]
			if got.Method != tc.method || got.Path != base+tc.path {
				t.Fatalf("wrong request %+v", got)
			}
			switch tc.action {
			case "create", "reply", "edit":
				if got.Body["body_markdown"] != body {
					t.Fatal("Markdown changed")
				}
			case "resolve", "reopen":
				if got.Body["resolved"] != (tc.action == "resolve") {
					t.Fatal(got.Body)
				}
			case "show":
				if got.Query.Get("with_section") != "true" {
					t.Fatal(got.Query)
				}
			case "list":
				if got.Query.Get("state") != "all" {
					t.Fatal(got.Query)
				}
			}
		})
	}
	out, _, code := executeBaseline(t, "comment", "reply", baselineTestProject, "--thread", baselineTestRevisionID, "--content-file", file)
	if code != 0 || !strings.Contains(out, "invocation_not_allowed") {
		t.Fatal(out)
	}
}

func TestBaselineCommentValidationBeforeNetwork(t *testing.T) {
	file := writeBaselineInput(t, "body")
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, input map[string]any) {
		t.Error("invalid input reached server")
	})
	for _, args := range [][]string{
		{"create", baselineTestProject, "--page", "a", "--content-file", file},
		{"reply", baselineTestProject, "--thread", "bad", "--content-file", file},
		{"list", baselineTestProject, "--page", "a", "--state", "bad"},
		{"list", baselineTestProject, "--page", "a", "--output", "table"},
		{"create", baselineTestProject, "--page", "a", "--quote", "text"},
	} {
		if _, _, code := executeBaseline(t, append([]string{"comment"}, args...)...); code == 0 {
			t.Fatal(args)
		}
	}
	if len(calls()) != 0 {
		t.Fatal(calls())
	}
}
