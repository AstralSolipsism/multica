package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

const baselineTestProject = "10000000-0000-4000-8000-000000000001"
const baselineTestPageID = "20000000-0000-4000-8000-000000000001"
const baselineTestRevisionID = "30000000-0000-4000-8000-000000000001"
const baselineTestIssueID = "40000000-0000-4000-8000-000000000001"

type baselineTestCall struct {
	Method, Path string
	Query        url.Values
	Body         map[string]any
}

func serveBaseline(t *testing.T, respond func(http.ResponseWriter, *http.Request, map[string]any)) (*httptest.Server, func() []baselineTestCall) {
	t.Helper()
	var mu sync.Mutex
	calls := []baselineTestCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mat_baseline_test" || r.Header.Get("X-Workspace-ID") != "offline-workspace" {
			t.Error("request lost task credentials or workspace")
		}
		var body map[string]any
		if r.Method == "POST" || r.Method == "PATCH" || r.Method == "PUT" {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
		}
		mu.Lock()
		calls = append(calls, baselineTestCall{r.Method, r.URL.Path, r.URL.Query(), body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		respond(w, r, body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_TOKEN", "mat_baseline_test")
	t.Setenv("MULTICA_WORKSPACE_ID", "offline-workspace")
	return srv, func() []baselineTestCall { mu.Lock(); defer mu.Unlock(); return append([]baselineTestCall{}, calls...) }
}

func executeBaseline(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	root := &cobra.Command{Use: "multica", SilenceErrors: true, SilenceUsage: true}
	root.PersistentFlags().String("profile", "", "")
	root.PersistentFlags().String("server-url", "", "")
	root.PersistentFlags().String("workspace-id", "", "")
	project := &cobra.Command{Use: "project"}
	project.AddCommand(newLabrastroProjectBaselineCmd())
	root.AddCommand(project)
	var out, stderr bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&stderr)
	root.SetArgs(append([]string{"project", "baseline"}, args...))
	cmd, err := root.ExecuteC()
	if err != nil {
		fmt.Fprintln(&stderr, cli.FormatError(err, false))
	}
	return out.String(), stderr.String(), labrastroBaselineExitCode(cmd, err)
}

func baselineJSON(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", err, s)
	}
	return m
}

func writeBaselineInput(t *testing.T, content string) string {
	t.Helper()
	t.Chdir(t.TempDir())
	if err := os.WriteFile("content.md", []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return "content.md"
}

// ---------- stub payloads ----------

func baselineWikiPage(slug, title string, number int32) map[string]any {
	return map[string]any{
		"id": baselineTestPageID, "slug": slug, "title": title, "parent_id": nil,
		"position": 0, "archived_at": nil, "current_revision_number": number,
		"created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z",
	}
}

func baselineWikiRevision(slug, title string, number int32, kind, content string) map[string]any {
	return map[string]any{
		"id": baselineTestRevisionID, "page_id": baselineTestPageID, "revision_number": number,
		"revision_kind": kind, "title": title, "slug": slug, "parent_id": nil, "position": 0,
		"content_markdown": content, "change_summary": "中文摘要", "base_revision_id": nil,
		"restored_from_revision_id": nil, "source_issue_id": nil,
		"created_by_type": "member", "created_by_id": "90000000-0000-4000-8000-000000000001",
		"created_by_task_id": nil, "created_at": "2026-11-01T00:00:00Z",
	}
}

func baselineWikiWriteResult(slug, title string, number int32, kind, content string, rebased bool) map[string]any {
	return map[string]any{
		"page":     baselineWikiPage(slug, title, number),
		"revision": baselineWikiRevision(slug, title, number, kind, content),
		"rebased":  rebased,
	}
}

func baselineWikiTree(pages ...map[string]any) map[string]any {
	return map[string]any{"pages": pages, "limits": map[string]int{"max_depth": 6, "max_pages": 500}}
}

func baselineWikiTreePage(slug, title string, number int32, sections []map[string]any, archived bool) map[string]any {
	page := baselineWikiPage(slug, title, number)
	page["depth"] = 1
	page["revision_count"] = number
	page["current"] = map[string]any{
		"number": number, "kind": "create", "created_at": "2026-11-01T00:00:00Z",
		"created_by_type": "member", "created_by_id": "90000000-0000-4000-8000-000000000001",
		"change_summary": "新建页面",
	}
	if sections == nil {
		sections = []map[string]any{}
	}
	page["sections"] = sections
	if archived {
		page["archived_at"] = "2026-11-02T00:00:00Z"
	}
	return page
}

func baselineWriteJSON(w http.ResponseWriter, status int, payload map[string]any) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

// ---------- flag validation (exit 2, no server traffic) ----------

func TestLabrastroBaselineFlagValidation(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		hint string
	}{
		{"write without page", []string{"write", baselineTestProject, "--base", "1", "--content-file", "x.md"}, "--page is required"},
		{"write without base", []string{"write", baselineTestProject, "--page", "p", "--content-file", "x.md"}, "--base is required"},
		{"write bad base", []string{"write", baselineTestProject, "--page", "p", "--base", "0", "--content-file", "x.md"}, "positive 32-bit integer"},
		{"write without content", []string{"write", baselineTestProject, "--page", "p", "--base", "1"}, "--content-file is required"},
		{"write both sections", []string{"write", baselineTestProject, "--page", "p", "--base", "1", "--section", "a", "--delete-section", "b", "--content-file", "x.md"}, "not both"},
		{"create without title", []string{"create", baselineTestProject}, "--title is required"},
		{"rename without change", []string{"rename", baselineTestProject, "--page", "p", "--base", "1"}, "--title and/or --slug"},
		{"move without target", []string{"move", baselineTestProject, "--page", "p", "--base", "1"}, "--parent"},
		{"archive without base", []string{"archive", baselineTestProject, "--page", "p"}, "--base is required"},
		{"rollback without to", []string{"rollback", baselineTestProject, "--page", "p", "--base", "1"}, "--to is required"},
		{"diff without from", []string{"diff", baselineTestProject, "--page", "p"}, "--from is required"},
		{"history without page", []string{"history", baselineTestProject}, "--page is required"},
		{"get revision without page", []string{"get", baselineTestProject, "--revision", "2"}, "--revision requires --page"},
		{"search without query", []string{"search", baselineTestProject}, "exactly one project ID and one query string"},
		{"two project args", []string{"tree", baselineTestProject, "extra"}, "exactly one project ID"},
		{"bad output", []string{"tree", baselineTestProject, "--output", "yaml"}, "unsupported --output"},
		{"get retired index flag", []string{"get", baselineTestProject, "--index"}, "--index is retired"},
		{"get retired candidate flag", []string{"get", baselineTestProject, "--candidate"}, "--candidate is retired"},
		{"get retired chapter module key", []string{"get", baselineTestProject, "--chapter", "module:overview"}, "use `get --page overview`"},
		{"get retired chapter slug", []string{"get", baselineTestProject, "--chapter", "overview"}, "use `get --page overview`"},
		{"get retired chapter revision", []string{"get", baselineTestProject, "--page", "p", "--revision", "3:2"}, "chapter:number is retired"},
		{"diff retired chapter", []string{"diff", baselineTestProject, "--page", "p", "--chapter", "module:arch"}, "use `diff --page arch`"},
		{"bad limit", []string{"history", baselineTestProject, "--page", "p", "--limit", "0"}, "positive 32-bit integer"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
				t.Errorf("validation failure reached the server: %s %s", r.Method, r.URL.Path)
				w.WriteHeader(500)
			})
			out, stderr, code := executeBaseline(t, tc.args...)
			if code != 2 || out != "" || !strings.Contains(stderr, tc.hint) {
				t.Fatalf("exit=%d out=%q stderr=%q want hint %q", code, out, stderr, tc.hint)
			}
			if len(calls()) != 0 {
				t.Fatal("validation failure issued requests")
			}
		})
	}
}

// ---------- tree / get ----------

func TestLabrastroBaselineTree(t *testing.T) {
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		if !strings.HasSuffix(r.URL.Path, "/baseline/tree") {
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		outline := []map[string]any{{"anchor": "goal", "title": "目标", "level": 2}}
		if r.URL.Query().Get("sections") == "false" {
			outline = nil
		}
		baselineWriteJSON(w, 200, baselineWikiTree(
			baselineWikiTreePage("overview", "总览", 2, outline, false),
			baselineWikiTreePage("legacy", "旧页", 1, nil, true),
		))
	})
	out, stderr, code := executeBaseline(t, "tree", baselineTestProject)
	if code != 0 || stderr != "" {
		t.Fatalf("tree failed: %d %s %s", code, out, stderr)
	}
	for _, want := range []string{"overview v2 总览", "# 目标", "(1 archived page(s)"} {
		if !strings.Contains(out, want) {
			t.Fatalf("tree output missing %q: %s", want, out)
		}
	}
	if strings.Contains(out, "legacy v1") {
		t.Fatalf("archived page listed as live: %s", out)
	}

	out, _, code = executeBaseline(t, "tree", baselineTestProject, "--no-sections")
	if code != 0 || strings.Contains(out, "# 目标") {
		t.Fatalf("--no-sections ignored: %s", out)
	}
	last := calls()[len(calls())-1]
	if last.Query.Get("sections") != "false" {
		t.Fatalf("sections query=%q", last.Query.Get("sections"))
	}

	out, _, code = executeBaseline(t, "tree", baselineTestProject, "--output", "json")
	if code != 0 || len(baselineJSON(t, out)["pages"].([]any)) != 2 {
		t.Fatalf("tree json: %d %s", code, out)
	}
}

func TestLabrastroBaselineTreeEmpty(t *testing.T) {
	_, _ = serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		baselineWriteJSON(w, 200, baselineWikiTree())
	})
	out, _, code := executeBaseline(t, "tree", baselineTestProject)
	if code != 0 || !strings.Contains(out, "(no pages") {
		t.Fatalf("empty tree: %d %q", code, out)
	}
}

func TestLabrastroBaselineGet(t *testing.T) {
	const body = "## 目标\n交付正文"
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case r.URL.Path == "/api/issues/"+baselineTestIssueID:
			baselineWriteJSON(w, 200, map[string]any{"id": baselineTestIssueID, "identifier": "OL-7", "title": "源 issue"})
		case strings.HasSuffix(r.URL.Path, "/baseline/pages/overview"):
			if r.URL.Query().Get("revision") != "" && r.URL.Query().Get("revision") != "1" {
				t.Error("wrong revision query")
			}
			baselineWriteJSON(w, 200, map[string]any{
				"page": baselineWikiPage("overview", "总览", 1), "revision": baselineWikiRevision("overview", "总览", 1, "create", body),
				"content_markdown": body,
			})
		case strings.HasSuffix(r.URL.Path, "/baseline/pages/overview") == false && strings.Contains(r.URL.Path, "/section"):
			baselineWriteJSON(w, 200, map[string]any{})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	out, stderr, code := executeBaseline(t, "get", baselineTestProject, "--page", "overview")
	if code != 0 || stderr != "" || !strings.Contains(out, body) {
		t.Fatalf("get markdown: %d %q %q", code, out, stderr)
	}
	if !strings.HasPrefix(out, "<!-- overview v1 · 总览 -->\n\n") {
		t.Fatalf("markdown get must print the version header as a comment: %q", out)
	}
	out, _, _ = executeBaseline(t, "get", baselineTestProject, "--page", "overview", "--revision", "1", "--output", "text")
	if !strings.HasPrefix(out, "overview v1 · 总览\n\n") || !strings.Contains(out, body) {
		t.Fatalf("text get header/body: %q", out)
	}
	out, _, code = executeBaseline(t, "get", baselineTestProject, "--page", "overview", "--output", "json")
	if code != 0 || baselineJSON(t, out)["content_markdown"] != body {
		t.Fatalf("get json: %d %s", code, out)
	}
	if got := calls()[len(calls())-1].Query.Get("with"); got != "links,backlinks,related_issues" {
		t.Fatalf("json get with=%q", got)
	}
}

// ---------- write lifecycle ----------

func TestLabrastroBaselineWriteLifecycle(t *testing.T) {
	file := writeBaselineInput(t, "# 新建正文\n")
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/baseline/pages"):
			if body["title"] != "新页" || body["slug"] != "new-page" || body["parent"] != "overview" || body["after"] != "first" {
				t.Errorf("create body: %+v", body)
			}
			if body["content_markdown"] != "# 新建正文\n" || body["change_summary"] != "初始" {
				t.Errorf("create content body: %+v", body)
			}
			baselineWriteJSON(w, 201, baselineWikiWriteResult("new-page", "新页", 1, "create", "# 新建正文\n", false))
		case r.Method == "PUT" && strings.HasSuffix(r.URL.Path, "/content"):
			if body["delete_section"] == nil && (body["base_revision_number"] != float64(1) || body["content_markdown"] != "# 新建正文\n") {
				t.Errorf("write body: %+v", body)
			}
			if body["delete_section"] != nil && body["content_markdown"] != nil {
				t.Errorf("delete body carries content: %+v", body)
			}
			baselineWriteJSON(w, 200, baselineWikiWriteResult("new-page", "新页", 2, "content", "# 新建正文\n", false))
		case r.Method == "PATCH" && strings.HasSuffix(r.URL.Path, "/baseline/pages/new-page"):
			if _, ok := body["title"]; ok {
				baselineWriteJSON(w, 200, baselineWikiWriteResult("new-page", "改名页", 3, "rename", "# 新建正文\n", false))
				return
			}
			if body["parent"] != "other" || body["after"] != "first" {
				t.Errorf("move body: %+v", body)
			}
			baselineWriteJSON(w, 200, baselineWikiWriteResult("new-page", "改名页", 4, "move", "# 新建正文\n", true))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/archive"):
			if body["recursive"] != true {
				t.Errorf("archive body: %+v", body)
			}
			baselineWriteJSON(w, 200, map[string]any{"pages": []any{
				baselineWikiWriteResult("new-page", "改名页", 5, "archive", "# 新建正文\n", false),
				baselineWikiWriteResult("child", "子页", 2, "archive", "子正文", false),
			}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/restore"):
			if body["parent"] != "new-home" {
				t.Errorf("restore body: %+v", body)
			}
			baselineWriteJSON(w, 200, map[string]any{"pages": []any{
				baselineWikiWriteResult("new-page", "改名页", 6, "restore", "# 新建正文\n", false),
			}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/rollback"):
			if body["revision_number"] != float64(2) || body["base_revision_number"] != float64(6) || body["content_only"] != true {
				t.Errorf("rollback body: %+v", body)
			}
			baselineWriteJSON(w, 201, baselineWikiWriteResult("new-page", "改名页", 7, "rollback", "# 新建正文\n", false))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})

	out, stderr, code := executeBaseline(t, "create", baselineTestProject, "--title", "新页", "--slug", "new-page",
		"--parent", "overview", "--after", "first", "--content-file", file, "--summary", "初始")
	if code != 0 || stderr != "" || !strings.Contains(out, "created: new-page v1") {
		t.Fatalf("create: %d %q %q", code, out, stderr)
	}
	out, _, code = executeBaseline(t, "write", baselineTestProject, "--page", "new-page", "--base", "1", "--content-file", file)
	if code != 0 || !strings.Contains(out, "written: new-page v2") || strings.Contains(out, "[rebased]") {
		t.Fatalf("write: %d %q", code, out)
	}
	out, _, code = executeBaseline(t, "rename", baselineTestProject, "--page", "new-page", "--base", "2", "--title", "改名页")
	if code != 0 || !strings.Contains(out, "renamed: new-page v3") {
		t.Fatalf("rename: %d %q", code, out)
	}
	out, _, code = executeBaseline(t, "move", baselineTestProject, "--page", "new-page", "--base", "3", "--parent", "other", "--after", "first")
	if code != 0 || !strings.Contains(out, "moved: new-page v4 (中文摘要) [rebased]") {
		t.Fatalf("move: %d %q", code, out)
	}
	out, _, code = executeBaseline(t, "archive", baselineTestProject, "--page", "new-page", "--base", "4", "--recursive")
	if code != 0 || !strings.Contains(out, "archived: new-page v5") || !strings.Contains(out, "archived: child v2") {
		t.Fatalf("archive: %d %q", code, out)
	}
	out, _, code = executeBaseline(t, "restore", baselineTestProject, "--page", "new-page", "--base", "5", "--parent", "new-home")
	if code != 0 || !strings.Contains(out, "restored: new-page v6") {
		t.Fatalf("restore: %d %q", code, out)
	}
	out, _, code = executeBaseline(t, "rollback", baselineTestProject, "--page", "new-page", "--to", "2", "--base", "6", "--content-only")
	if code != 0 || !strings.Contains(out, "rolled back: new-page v7") {
		t.Fatalf("rollback: %d %q", code, out)
	}
	out, _, code = executeBaseline(t, "write", baselineTestProject, "--page", "new-page", "--base", "7", "--delete-section", "旧节")
	if code != 0 {
		t.Fatalf("delete-section: %d %q", code, out)
	}
	if last := calls()[len(calls())-1]; last.Body["delete_section"] != "旧节" {
		t.Fatalf("delete-section body: %+v", last.Body)
	}
}

func TestLabrastroBaselineConflictExitCode(t *testing.T) {
	file := writeBaselineInput(t, "正文")
	_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		w.WriteHeader(409)
		json.NewEncoder(w).Encode(map[string]any{
			"code": "baseline_conflict", "error": "baseline conflict",
			"current": map[string]any{"revision_number": 9, "kind": "content", "change_summary": "别人先写"},
		})
	})
	for _, args := range [][]string{
		{"write", baselineTestProject, "--page", "p", "--base", "1", "--content-file", file},
		{"rename", baselineTestProject, "--page", "p", "--base", "1", "--title", "t"},
		{"move", baselineTestProject, "--page", "p", "--base", "1", "--root"},
		{"archive", baselineTestProject, "--page", "p", "--base", "1"},
		{"rollback", baselineTestProject, "--page", "p", "--to", "1", "--base", "1"},
	} {
		out, stderr, code := executeBaseline(t, args...)
		if code != 3 || out != "" || !strings.Contains(stderr, "conflict") || !strings.Contains(stderr, "--base") {
			t.Fatalf("%v: exit=%d out=%q stderr=%q", args, code, out, stderr)
		}
	}
}

func TestLabrastroBaselineRetiredCommands(t *testing.T) {
	_, calls := serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		t.Error("retired command reached the server")
		w.WriteHeader(500)
	})
	for _, tc := range []struct {
		name string
		args []string
		hint string
	}{
		{"propose", nil, "candidates are retired"},
		{"adopt", nil, "decisions are retired"},
		{"annotations", nil, "annotation batches are retired"},
		{"respond", nil, "annotation batches are retired"},
		// Old invocations carry flags Cobra would reject; parsing is disabled
		// so the migration hint always reaches the caller.
		{"propose", []string{"--chapter", "overview", "--content-file", "x.md"}, "candidates are retired"},
		{"adopt", []string{"--chapter", "overview", "--decision", "approve"}, "decisions are retired"},
		{"annotations", []string{"--batch", "b"}, "annotation batches are retired"},
		{"respond", []string{"--batch", "b", "--response", "r"}, "annotation batches are retired"},
	} {
		args := append([]string{tc.name, baselineTestProject}, tc.args...)
		out, stderr, code := executeBaseline(t, args...)
		if code != 2 || out != "" || !strings.Contains(stderr, "retired") || !strings.Contains(stderr, tc.hint) {
			t.Fatalf("%s %v: exit=%d out=%q stderr=%q", tc.name, tc.args, code, out, stderr)
		}
	}
	if len(calls()) != 0 {
		t.Fatal("retired commands issued requests")
	}
}

// ---------- history / diff / activity / search ----------

func TestLabrastroBaselineHistoryDiffActivitySearch(t *testing.T) {
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/revisions"):
			baselineWriteJSON(w, 200, map[string]any{"revisions": []any{
				baselineWikiRevision("overview", "总览", 2, "content", "正文 v2"),
				baselineWikiRevision("overview", "总览", 1, "create", "正文 v1"),
			}, "has_more": false, "next_before": nil})
		case strings.HasSuffix(r.URL.Path, "/diff"):
			baselineWriteJSON(w, 200, map[string]any{
				"structure": map[string]any{"title": map[string]any{"from": "旧标题", "to": "新标题"}},
				"sections": map[string]any{
					"added":    []any{map[string]any{"title": "新增节"}},
					"modified": []any{},
					"removed":  []any{map[string]any{"title": "删除节"}},
				},
			})
		case strings.HasSuffix(r.URL.Path, "/activity"):
			baselineWriteJSON(w, 200, map[string]any{"items": []any{map[string]any{
				"page_id": baselineTestPageID, "slug": "overview", "title": "总览", "kind": "content",
				"number": 2, "created_at": "2026-11-01T00:00:00Z", "created_by_type": "agent",
				"created_by_id": "90000000-0000-4000-8000-000000000001", "change_summary": "更新正文",
			}}})
		case strings.HasSuffix(r.URL.Path, "/search"):
			if r.URL.Query().Get("q") != "目标" {
				t.Errorf("search q=%q", r.URL.Query().Get("q"))
			}
			baselineWriteJSON(w, 200, map[string]any{"results": []any{map[string]any{
				"page_id": baselineTestPageID, "slug": "overview", "title": "总览",
				"section_title": "目标", "snippet": "……目标……", "match": "section",
			}}})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	out, stderr, code := executeBaseline(t, "history", baselineTestProject, "--page", "overview", "--limit", "10", "--before", "3")
	if code != 0 || stderr != "" || !strings.Contains(out, "v2    content") || !strings.Contains(out, "v1    create") {
		t.Fatalf("history: %d %q %q", code, out, stderr)
	}
	last := calls()[len(calls())-1]
	if last.Query.Get("with_content") != "false" || last.Query.Get("limit") != "10" || last.Query.Get("before") != "3" {
		t.Fatalf("history query: %+v", last.Query)
	}

	out, _, code = executeBaseline(t, "diff", baselineTestProject, "--page", "overview", "--from", "1", "--to", "2")
	if code != 0 || !strings.Contains(out, "title: 旧标题 → 新标题") || !strings.Contains(out, "+ 新增节") || !strings.Contains(out, "- 删除节") {
		t.Fatalf("diff: %d %q", code, out)
	}

	out, _, code = executeBaseline(t, "activity", baselineTestProject, "--limit", "5")
	if code != 0 || !strings.Contains(out, "overview v2 content") || !strings.Contains(out, "更新正文") {
		t.Fatalf("activity: %d %q", code, out)
	}

	out, _, code = executeBaseline(t, "search", baselineTestProject, "目标", "--limit", "3")
	if code != 0 || !strings.Contains(out, "[overview#目标] 总览 (section)") || !strings.Contains(out, "……目标……") {
		t.Fatalf("search: %d %q", code, out)
	}
}

// ---------- export ----------

func TestLabrastroBaselineExport(t *testing.T) {
	t.Chdir(t.TempDir())
	_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/baseline/tree"):
			baselineWriteJSON(w, 200, baselineWikiTree(
				baselineWikiTreePage("overview", "总览", 1, nil, false),
				baselineWikiTreePage("rules", "规则", 2, nil, false),
				baselineWikiTreePage("sourced", "带来源", 3, nil, false),
				baselineWikiTreePage("gone", "已归档", 1, nil, true),
			))
		case strings.HasSuffix(r.URL.Path, "/baseline/pages/overview"):
			baselineWriteJSON(w, 200, map[string]any{
				"page": baselineWikiPage("overview", "总览", 1), "revision": baselineWikiRevision("overview", "总览", 1, "create", "# 总览正文"),
				"content_markdown": "# 总览正文",
			})
		case strings.HasSuffix(r.URL.Path, "/baseline/pages/rules"):
			baselineWriteJSON(w, 200, map[string]any{
				"page": baselineWikiPage("rules", "规则", 2), "revision": baselineWikiRevision("rules", "规则", 2, "content", "# 规则正文"),
				"content_markdown": "# 规则正文",
			})
		case strings.HasSuffix(r.URL.Path, "/baseline/pages/sourced"):
			sourced := baselineWikiRevision("sourced", "带来源", 3, "content", "# 带来源正文")
			sourced["source_issue_id"] = baselineTestIssueID
			baselineWriteJSON(w, 200, map[string]any{
				"page": baselineWikiPage("sourced", "带来源", 3), "revision": sourced,
				"content_markdown": "# 带来源正文",
			})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	dir := filepath.Join(".", "snapshot")
	out, stderr, code := executeBaseline(t, "export", baselineTestProject, "--dir", dir)
	if code != 0 || stderr != "" {
		t.Fatalf("export failed: %d %s %s", code, out, stderr)
	}
	titles := map[string]string{"overview": "总览", "rules": "规则", "sourced": "带来源"}
	for slug, header := range map[string]string{
		"overview": "slug: overview\ntitle: \"总览\"\nrevision: 1\nrevision_at: 2026-11-01T00:00:00Z\nexported_at: ",
		"rules":    "slug: rules\ntitle: \"规则\"\nrevision: 2\nrevision_at: 2026-11-01T00:00:00Z\nexported_at: ",
		"sourced":  "slug: sourced\ntitle: \"带来源\"\nrevision: 3\nsource_issue: " + baselineTestIssueID + "\nrevision_at: 2026-11-01T00:00:00Z\nexported_at: ",
	} {
		body, err := os.ReadFile(filepath.Join(dir, slug+".md"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(body), "---\n"+header) || !strings.HasSuffix(string(body), "\n---\n\n# "+titles[slug]+"正文\n") {
			t.Fatalf("exported %s: %s", slug, body)
		}
		if slug != "sourced" && strings.Contains(string(body), "source_issue") {
			t.Fatalf("exported %s must omit source_issue when unset: %s", slug, body)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "gone.md")); err == nil {
		t.Fatal("archived page exported")
	}

	out, _, code = executeBaseline(t, "export", baselineTestProject, "--single-file", "ALL.md")
	if code != 0 {
		t.Fatalf("single-file export: %d %s", code, out)
	}
	combined, _ := os.ReadFile("ALL.md")
	if strings.Count(string(combined), "slug: overview") != 1 || !strings.Contains(string(combined), "# 规则正文") {
		t.Fatalf("single-file export: %s", combined)
	}
}

// ---------- --source-issue resolution ----------

func TestLabrastroBaselineSourceIssueResolution(t *testing.T) {
	file := writeBaselineInput(t, "正文")
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case r.URL.Path == "/api/issues/OL-42":
			baselineWriteJSON(w, 200, map[string]any{"id": baselineTestIssueID, "identifier": "OL-42", "title": "来源"})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/baseline/pages"):
			baselineWriteJSON(w, 201, baselineWikiWriteResult("src", "来源页", 1, "create", "正文", false))
		case r.Method == "PUT":
			baselineWriteJSON(w, 200, baselineWikiWriteResult("src", "来源页", 2, "content", "正文", false))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})
	_, stderr, code := executeBaseline(t, "create", baselineTestProject, "--title", "来源页", "--slug", "src",
		"--content-file", file, "--source-issue", "OL-42")
	if code != 0 || stderr != "" {
		t.Fatalf("create with OL ref: %d %s", code, stderr)
	}
	var createBody map[string]any
	for _, call := range calls() {
		if call.Method == "POST" {
			createBody = call.Body
		}
	}
	if createBody == nil || createBody["source_issue_id"] != baselineTestIssueID {
		t.Fatalf("source issue not resolved to UUID: %+v", createBody)
	}

	uuidFile := writeBaselineInput(t, "正文")
	_, stderr, code = executeBaseline(t, "write", baselineTestProject, "--page", "src", "--base", "1",
		"--content-file", uuidFile, "--source-issue", baselineTestIssueID)
	if code != 0 || stderr != "" {
		t.Fatalf("write with UUID ref: %d %s", code, stderr)
	}
	found := false
	for _, call := range calls() {
		if call.Method == "PUT" && call.Body["source_issue_id"] == baselineTestIssueID {
			found = true
		}
	}
	if !found {
		t.Fatal("UUID source issue not passed through")
	}
}

// ---------- malformed responses ----------

func TestLabrastroBaselineMalformedResponses(t *testing.T) {
	for _, tc := range []struct {
		response map[string]any
		args     []string
	}{
		{map[string]any{"revisions": "nope"}, []string{"history", baselineTestProject, "--page", "p"}},
		{map[string]any{"items": "nope"}, []string{"activity", baselineTestProject}},
		{map[string]any{"results": "nope"}, []string{"search", baselineTestProject, "needle"}},
		{map[string]any{"pages": "nope"}, []string{"tree", baselineTestProject}},
	} {
		t.Run(fmt.Sprint(tc.response, tc.args[0]), func(t *testing.T) {
			_, _ = serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
				json.NewEncoder(w).Encode(tc.response)
			})
			out, _, code := executeBaseline(t, tc.args...)
			if code != 1 || out != "" {
				t.Fatalf("%v: malformed response reported success: %d %q", tc.args, code, out)
			}
		})
	}
}

func TestLabrastroBaselineRegistration(t *testing.T) {
	for _, action := range []string{"tree", "get", "create", "write", "rename", "move", "archive", "restore", "history", "diff", "rollback", "activity", "search", "export", "propose", "adopt", "annotations", "respond"} {
		root := &cobra.Command{Use: "multica"}
		project := &cobra.Command{Use: "project"}
		project.AddCommand(newLabrastroProjectBaselineCmd())
		root.AddCommand(project)
		cmd, _, err := root.Find([]string{"project", "baseline", action})
		if err != nil || cmd.Name() != action {
			t.Fatalf("%s is not registered", action)
		}
	}
}
