package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/engineering"
)

func copyLintFixtures(t *testing.T) {
	t.Helper()
	_, source, _, _ := runtime.Caller(0)
	fixtureDir := filepath.Join(filepath.Dir(source), "../../internal/engineering/testdata/lint/valid")
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(fixtureDir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files[e.Name()] = data
	}
	t.Chdir(t.TempDir())
	if err := os.Mkdir("baseline", 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join("baseline", name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLabrastroBaselineLintOffline(t *testing.T) {
	copyLintFixtures(t)
	t.Setenv("MULTICA_TOKEN", "")
	t.Setenv("MULTICA_SERVER_URL", "http://127.0.0.1:1")
	out, stderr, code := executeBaseline(t, "lint", "--dir", "baseline", "--output", "json")
	result := baselineJSON(t, out)
	if code != 0 || stderr != "" || result["ok"] != true || len(result["diagnostics"].([]any)) != 0 {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
	data, err := os.ReadFile("baseline/order-service.md")
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), "payment -->|回调| worker", "worker --> backdoor", 1))
	if err := os.WriteFile("baseline/order-service.md", data, 0600); err != nil {
		t.Fatal(err)
	}
	out, stderr, code = executeBaseline(t, "lint", "--dir", "baseline", "--page", "architecture", "--output", "json")
	result = baselineJSON(t, out)
	if code != 1 || result["ok"] != false || result["error_count"] != float64(2) {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
	for _, item := range result["diagnostics"].([]any) {
		d := item.(map[string]any)
		for _, key := range []string{"severity", "code", "page", "section", "line", "message"} {
			if _, exists := d[key]; !exists {
				t.Fatalf("missing %s: %v", key, d)
			}
		}
	}
	out, stderr, code = executeBaseline(t, "lint", "--dir", "baseline", "--page", "domain_rules")
	if code != 0 || out != "0 error(s), 0 warning(s)\n" || stderr != "" {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
}

func TestLabrastroBaselineLintUsageAndFiles(t *testing.T) {
	copyLintFixtures(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "escape.md"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, "escape-dir"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "escape.md"), "baseline/escape.md"); err != nil {
		t.Fatal(err)
	}
	cases := [][]string{
		{"lint"}, {"lint", baselineTestProject, "--dir", "baseline"}, {"lint", "a", "b"},
		{"lint", "--dir", ""}, {"lint", "--dir", "baseline", "--page", ""},
		{"lint", "--dir", "baseline", "--output", "table"}, {"lint", "--dir", ".."},
		{"lint", "--dir", "escape-dir"}, {"lint", "--dir", "baseline"}, {"lint", "--dir", "missing"},
		{"lint", "--dir", "baseline", "--unknown"},
	}
	for _, args := range cases {
		out, stderr, code := executeBaseline(t, args...)
		if code != 2 || out != "" || stderr == "" {
			t.Fatalf("%v: %d %q %q", args, code, out, stderr)
		}
	}
	if err := os.Remove("baseline/escape.md"); err != nil {
		t.Fatal(err)
	}
	out, stderr, code := executeBaseline(t, "lint", "--dir", "baseline", "--page", "missing")
	if code != 2 || !strings.Contains(stderr, "not an active page") || out != "" {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
}

func TestLabrastroBaselineLintMalformedExport(t *testing.T) {
	cases := []string{
		"no frontmatter",
		"---\nslug: x\nslug: y\ntitle: Title\n---\nbody",
		"---\nslug: ../bad\ntitle: Title\n---\nbody",
		"---\nslug: page\ntitle: Title\nparent: missing\n---\nbody",
		"---\nslug: page\ntitle: Title\nparent: page\n---\nbody",
	}
	for i, content := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t.Chdir(t.TempDir())
			if err := os.WriteFile("page.md", []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			out, stderr, code := executeBaseline(t, "lint", "--dir", ".")
			if code != 2 || out != "" || stderr == "" {
				t.Fatalf("%d %s %s", code, out, stderr)
			}
		})
	}
}

func TestLabrastroBaselineLintOnlineExportParity(t *testing.T) {
	copyLintFixtures(t)
	pages, err := baselineLintReadDir("baseline")
	if err != nil {
		t.Fatal(err)
	}
	bySlug := map[string]engineering.LintPage{}
	ids := map[string]string{}
	for i, p := range pages {
		bySlug[p.Slug] = p
		ids[p.Slug] = fmt.Sprintf("page-%d", i)
	}
	tree := []map[string]any{}
	for _, p := range pages {
		meta := baselineWikiTreePage(p.Slug, p.Title, 1, nil, false)
		meta["id"] = ids[p.Slug]
		if p.Parent != "" {
			meta["parent_id"] = ids[p.Parent]
		}
		tree = append(tree, meta)
	}
	tree = append(tree, baselineWikiTreePage("archived", "Archived", 1, nil, true))
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		if r.URL.Path == "/api/projects/"+baselineTestProject+"/baseline/tree" {
			baselineWriteJSON(w, 200, baselineWikiTree(tree...))
			return
		}
		slug := strings.TrimPrefix(r.URL.Path, "/api/projects/"+baselineTestProject+"/baseline/pages/")
		p, ok := bySlug[slug]
		if !ok {
			t.Errorf("unexpected fetch %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		baselineWriteJSON(w, 200, map[string]any{"page": baselineWikiPage(p.Slug, p.Title, 1), "revision": baselineWikiRevision(p.Slug, p.Title, 1, "create", p.Content), "content_markdown": p.Content})
	})
	online, stderr, code := executeBaseline(t, "lint", baselineTestProject, "--output", "json")
	if code != 0 || stderr != "" {
		t.Fatalf("%d %s %s", code, online, stderr)
	}
	offline, _, code := executeBaseline(t, "lint", "--dir", "baseline", "--output", "json")
	if code != 0 || online != offline {
		t.Fatalf("parity: %s vs %s", online, offline)
	}
	_, stderr, code = executeBaseline(t, "export", baselineTestProject, "--dir", "roundtrip")
	if code != 0 {
		t.Fatal(stderr)
	}
	exported, err := baselineLintReadDir("roundtrip")
	if err != nil {
		t.Fatal(err)
	}
	original := map[string]engineering.LintPage{}
	for _, p := range pages {
		original[p.Slug] = p
	}
	for _, p := range exported {
		if !reflect.DeepEqual(original[p.Slug], p) {
			t.Fatalf("lost tree/body: %+v vs %+v", original[p.Slug], p)
		}
	}
	child := bySlug["order-service"]
	child.Content = strings.Replace(child.Content, "payment -->|回调| worker", "worker --> backdoor", 1)
	bySlug[child.Slug] = child
	online, stderr, code = executeBaseline(t, "lint", baselineTestProject, "--page", "architecture", "--output", "json")
	var result engineering.LintResult
	if err := json.Unmarshal([]byte(online), &result); err != nil {
		t.Fatal(err)
	}
	if code != 1 || result.ErrorCount != 2 {
		t.Fatalf("%d %s %s", code, online, stderr)
	}
	for _, call := range calls() {
		if call.Method != "GET" {
			t.Fatalf("lint/export wrote: %+v", call)
		}
	}
}

func TestLabrastroBaselineLintRequestFailure(t *testing.T) {
	for _, status := range []int{400, 401, 404, 409, 422, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
				baselineWriteJSON(w, status, map[string]any{"error": "baseline_conflict"})
			})
			out, stderr, code := executeBaseline(t, "lint", baselineTestProject, "--output", "json")
			if code != 1 || out != "" || stderr == "" {
				t.Fatalf("%d %s %s", code, out, stderr)
			}
		})
	}
}

func TestLabrastroBaselineLintWarningsSucceed(t *testing.T) {
	t.Chdir(t.TempDir())
	content := baselineExportHeader("page", "Page", 1, "", "") + "```text\n[[missing]]\n```\n"
	if err := os.WriteFile("page.md", []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	out, stderr, code := executeBaseline(t, "lint", "--dir", ".", "--output", "json")
	result := baselineJSON(t, out)
	if code != 0 || stderr != "" || result["warning_count"] != float64(1) || result["ok"] != true {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
}

func TestLabrastroBaselineLintMalformedResponse(t *testing.T) {
	serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		baselineWriteJSON(w, 200, map[string]any{})
	})
	out, stderr, code := executeBaseline(t, "lint", baselineTestProject, "--output", "json")
	if code != 1 || out != "" || !strings.Contains(stderr, "invalid baseline tree") {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
}

func TestLabrastroBaselineLintVerifiesHtmlAttachmentBinding(t *testing.T) {
	const content = "## 架构\n\n```c4\nmodel {\n  api = system 'API'\n}\n```\n\n```html src=\"architecture.html\" title=\"架构画布\"\n交互画布见附件。\n```\n"
	serve := func(t *testing.T, attachments []any) {
		t.Helper()
		tree := []map[string]any{baselineWikiTreePage("architecture", "架构", 1, nil, false)}
		_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
			if r.URL.Path == "/api/projects/"+baselineTestProject+"/baseline/tree" {
				baselineWriteJSON(w, 200, baselineWikiTree(tree...))
				return
			}
			baselineWriteJSON(w, 200, map[string]any{
				"page":             baselineWikiPage("architecture", "架构", 1),
				"revision":         baselineWikiRevision("architecture", "架构", 1, "create", content),
				"content_markdown": content,
				"attachments":      attachments,
			})
		})
	}

	serve(t, []any{})
	out, _, code := executeBaseline(t, "lint", baselineTestProject, "--output", "json")
	result := baselineJSON(t, out)
	if code != 1 || result["ok"] != false {
		t.Fatalf("%d %s", code, out)
	}
	codes := []string{}
	for _, item := range result["diagnostics"].([]any) {
		codes = append(codes, item.(map[string]any)["code"].(string))
	}
	if !reflect.DeepEqual(codes, []string{"html_attachment_missing"}) {
		t.Fatalf("diagnostics = %v", codes)
	}

	serve(t, []any{map[string]any{"id": "att-1", "filename": "architecture.html"}})
	out, stderr, code := executeBaseline(t, "lint", baselineTestProject, "--output", "json")
	if code != 0 || stderr != "" || baselineJSON(t, out)["ok"] != true {
		t.Fatalf("%d %s %s", code, out, stderr)
	}
}
