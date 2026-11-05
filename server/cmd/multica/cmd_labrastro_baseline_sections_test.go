package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLabrastroBaselineCompactReads(t *testing.T) {
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		if !strings.HasSuffix(r.URL.Path, "/baseline") {
			t.Errorf("full overview requested: %s", r.URL)
			w.WriteHeader(500)
			return
		}
		if r.URL.Query().Get("index") == "true" {
			json.NewEncoder(w).Encode(map[string]any{"chapters": []any{map[string]any{"chapter": "module:billing", "title": "计费", "position": 4, "revision_id": baselineTestBase, "revision_number": 1, "status": "adopted", "sections": []any{map[string]any{"anchor": "Pay", "title": "Pay", "level": 2}}}}})
			return
		}
		if r.URL.Query().Get("section") != "Pay" || r.URL.Query().Get("chapter") != "module:billing" {
			t.Error("lost query")
		}
		json.NewEncoder(w).Encode(map[string]any{"sections": []any{map[string]any{"chapter": "module:billing", "anchor": "Pay", "title": "Pay", "level": 2, "content_markdown": "## Pay\nUses Account."}}, "referenced_sections": []any{map[string]any{"chapter": "domain_rules", "anchor": "Account", "title": "Account", "level": 2, "definition": "Customer identity", "why": "Traceability"}}})
	})
	for _, output := range []string{"text", "json"} {
		out, stderr, code := executeBaseline(t, "get", baselineTestProject, "--index", "--output", output)
		if code != 0 || !strings.Contains(out, "计费") || !strings.Contains(out, "Pay") {
			t.Fatalf("%d %s %s", code, out, stderr)
		}
		out, stderr, code = executeBaseline(t, "get", baselineTestProject, "--section", "Pay", "--chapter", "module:billing", "--output", output)
		if code != 0 || !strings.Contains(out, "Customer identity") || !strings.Contains(out, "Traceability") || output == "text" && !strings.Contains(out, "### 关联概念摘要") {
			t.Fatalf("%d %s %s", code, out, stderr)
		}
	}
	if len(calls()) != 4 {
		t.Fatalf("requests=%+v", calls())
	}
}

func TestLabrastroBaselineModuleProposeAndDelete(t *testing.T) {
	file := writeBaselineInput(t)
	a, c := baselineTestRevision("module:billing", 1, "adopted"), baselineTestRevision("module:billing", 2, "candidate")
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		if strings.HasSuffix(r.URL.Path, "/engineering") {
			state := baselineTestState(nil, nil)
			state["chapters"] = append(state["chapters"].([]any), map[string]any{"chapter": "module:billing", "title": "计费", "adopted": a, "candidate": nil})
			json.NewEncoder(w).Encode(state)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/baseline/revisions") {
			json.NewEncoder(w).Encode(map[string]any{"revisions": []any{c}})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/baseline/decisions") {
			items := body["revisions"].([]any)
			item := items[0].(map[string]any)
			if body["action"] != "adopt" || item["revision_id"] != baselineTestCandidate || item["expected_adopted_revision_id"] != baselineTestBase {
				t.Errorf("decision=%+v", body)
			}
			json.NewEncoder(w).Encode(map[string]any{"chapters": []any{}, "open_issues": map[string]any{"in_flight": []any{}, "queued": []any{}, "truncated": false}})
			return
		}
		json.NewEncoder(w).Encode(c)
	})
	_, stderr, code := executeBaseline(t, "propose", baselineTestProject, "--chapter", "module:billing", "--chapter-title", "计费", "--section", "Rule-中文", "--content-file", file, "--summary", "Update", "--base-current", "--output", "json")
	if code != 0 {
		t.Fatal(stderr)
	}
	body := calls()[1].Body
	if body["chapter"] != "module:billing" || body["section"] != "Rule-中文" || body["chapter_title"] != "计费" || body["base_revision_id"] != baselineTestBase {
		t.Fatalf("body=%+v", body)
	}
	_, stderr, code = executeBaseline(t, "propose", baselineTestProject, "--chapter", "module:billing", "--delete-section", "Rule-中文", "--summary", "Remove", "--base-current", "--output", "json")
	if code != 0 {
		t.Fatal(stderr)
	}
	body = calls()[3].Body
	if body["delete_section"] != true || body["section"] != "Rule-中文" || body["content_markdown"] != "" {
		t.Fatalf("delete=%+v", body)
	}
	_, stderr, code = executeBaseline(t, "get", baselineTestProject, "--revision", "module:billing:2", "--output", "json")
	if code != 0 {
		t.Fatal(stderr)
	}
	_, stderr, code = executeBaseline(t, "adopt", baselineTestProject, "--revision", "module:billing:2", "--output", "json")
	if code != 0 {
		t.Fatal(stderr)
	}
	dir := filepath.Join(t.TempDir(), "snapshots")
	_, stderr, code = executeBaseline(t, "export", baselineTestProject, "--dir", dir, "--output", "json")
	if code != 0 {
		t.Fatal(stderr)
	}
	exported, err := os.ReadFile(filepath.Join(dir, "05-module-billing.md"))
	if err != nil || !strings.Contains(string(exported), "MUST keep body") {
		t.Fatalf("export=%s err=%v", exported, err)
	}

}

func TestLabrastroBaselineSectionFlagErrors(t *testing.T) {
	for _, args := range [][]string{
		{"get", baselineTestProject, "--index", "--section", "Pay"},
		{"get", baselineTestProject, "--section", ""},
		{"get", baselineTestProject, "--index", "--revision", "overview:1"},
		{"propose", baselineTestProject, "--chapter", "module:billing", "--delete-section", "Pay", "--content-file", "unused.md", "--summary", "Remove"},
		{"propose", baselineTestProject, "--chapter", "module:billing", "--section", "Pay", "--delete-section", "Pay", "--summary", "Remove"},
	} {
		_, stderr, code := executeBaseline(t, args...)
		if code != 2 {
			t.Fatalf("%v: %d %s", args, code, stderr)
		}
	}
}
