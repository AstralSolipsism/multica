package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const baselineTestBatch = "50000000-0000-4000-8000-000000000001"
const baselineTestAnnotationID = "60000000-0000-4000-8000-000000000001"
const baselineTestAgentID = "70000000-0000-4000-8000-000000000001"

func baselineAnnotationBatchResponse(working map[string]any, annotations []any, sections []any) map[string]any {
	if working == nil {
		working = map[string]any{"revision_id": baselineTestCandidate, "revision_number": 5, "status": "candidate"}
	}
	return map[string]any{
		"batch": map[string]any{
			"id": baselineTestBatch, "chapter": "domain_rules", "state": "active",
			"carrier":  map[string]any{"kind": "source_issue", "issue_id": baselineTestIssue, "identifier": "OL-1240"},
			"agent_id": baselineTestAgentID,
			"working":  working,
			"counts":   map[string]any{"open": 2, "resolved": 1},
		},
		"reviews":     []any{map[string]any{"id": "50000000-0000-4000-8000-000000000002", "summary": "统一结算口径", "created_at": "2026-11-06T00:00:00Z"}},
		"annotations": annotations,
		"sections":    sections,
	}
}

func baselineTestAnnotation(id string, ordinal int, extra map[string]any) map[string]any {
	a := map[string]any{
		"id": id, "ordinal": ordinal, "parent_annotation_id": nil,
		"anchor_kind": "lines", "section_anchor": "RULE-3", "section_title": "结算规则",
		"target_revision_id": baselineTestCandidate, "target_revision_number": 5, "side": "after",
		"line_start": 13, "line_end": 13, "quote": "T+1 日结算", "prefix": "", "suffix": "", "start": 0,
		"note": "补一句跨月规则", "response": nil, "state": "open", "location": "exact",
		"located":       map[string]any{"revision_number": 5, "line_start": 13, "line_end": 13},
		"created_by_id": "80000000-0000-4000-8000-000000000001",
	}
	for k, v := range extra {
		a[k] = v
	}
	return a
}

func TestLabrastroBaselineAnnotationsCommand(t *testing.T) {
	annotations := []any{
		baselineTestAnnotation(baselineTestAnnotationID, 1, nil),
		baselineTestAnnotation("60000000-0000-4000-8000-000000000002", 2, map[string]any{
			"anchor_kind": "text", "line_start": nil, "line_end": nil, "located": nil, "location": "moved",
			"section_anchor": "Pricing / Discount", "section_title": "折扣", "quote": "折扣叠加上限 30%",
			"note": "上限按会员等级区分",
		}),
		baselineTestAnnotation("60000000-0000-4000-8000-000000000003", 3, map[string]any{
			"anchor_kind": "section", "line_start": nil, "line_end": nil, "located": nil, "quote": "",
			"section_anchor": "退款", "section_title": "退款", "note": "缺少部分退款规则",
			"response": "已补充，见 v5 第 14 行",
		}),
		baselineTestAnnotation("60000000-0000-4000-8000-000000000004", 4, map[string]any{
			"anchor_kind": "lines", "section_anchor": "RULE-3", "section_title": "结算规则",
			"quote": "T+1 日结算", "note": "人回复后的父批注",
			"location": "moved",
			"located":  map[string]any{"revision_number": 5, "line_start": 14, "line_end": 15},
		}),
		baselineTestAnnotation("60000000-0000-4000-8000-000000000005", 5, map[string]any{
			"anchor_kind": "text", "parent_annotation_id": "60000000-0000-4000-8000-000000000004",
			"line_start": nil, "line_end": nil, "located": nil, "quote": "",
			"section_anchor": "RULE-3", "note": "参考 RULE-7 的写法",
		}),
	}
	var gotPath, gotQuery string
	_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/annotation-batches/"+baselineTestBatch):
			gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
			sections := []any{}
			if r.URL.Query().Get("with_sections") == "true" {
				sections = []any{map[string]any{"chapter": "domain_rules", "anchor": "RULE-3", "title": "结算规则", "level": 2, "content_markdown": "## [RULE-3] 结算规则\nT+1 日结算\n"}}
			}
			json.NewEncoder(w).Encode(baselineAnnotationBatchResponse(nil, annotations, sections))
		case strings.HasSuffix(r.URL.Path, "/annotation-batches"):
			if r.URL.Query().Get("issue_id") != baselineTestIssue || r.URL.Query().Get("state") != "active" {
				t.Error("batch-by-issue lookup used wrong filters")
			}
			json.NewEncoder(w).Encode(map[string]any{"batches": []any{map[string]any{
				"id": baselineTestBatch, "state": "active",
				"carrier": map[string]any{"kind": "source_issue", "issue_id": baselineTestIssue, "identifier": "OL-1240"},
			}}})
		case strings.Contains(r.URL.Path, "/issues/"):
			json.NewEncoder(w).Encode(map[string]any{"id": baselineTestIssue, "identifier": "OL-1240"})
		case strings.HasSuffix(r.URL.Path, "/members"):
			json.NewEncoder(w).Encode([]any{map[string]any{"user_id": "80000000-0000-4000-8000-000000000001", "name": "Master"}})
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})

	// Text output with a batch UUID and default --state open.
	out, stderr, code := executeBaseline(t, "annotations", baselineTestProject, "--batch", baselineTestBatch)
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	for _, want := range []string{
		"批注批次 50000000…（承载 OL-1240）· domain_rules · 工作版本 candidate v5 · 未解决 2/3",
		"总体说明：统一结算口径",
		"[A1] RULE-3 结算规则 · 改动后 v5 第 13 行 · 定位 exact",
		"  原文：T+1 日结算",
		"  批注：补一句跨月规则",
		"[A2] Pricing / Discount 折扣 · 正本 v5 选中文字 · 定位 moved",
		"[A3] 退款 · 整节",
		"  ↳ 智能体回应（上轮）：已补充，见 v5 第 14 行",
		"[A4] RULE-3 结算规则 · 改动后 v5 第 14–15 行 · 定位 moved（已在 v5 第 14–15 行重新定位）",
		"  ↳ 回复（Master）：参考 RULE-7 的写法",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("text output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "--with-sections") {
		t.Fatal("sections appended without --with-sections")
	}
	if gotQuery != "state=open" {
		t.Fatalf("default state query: %q", gotQuery)
	}

	// Default --state open must drop resolved annotations server-side.
	out, _, code = executeBaseline(t, "annotations", baselineTestProject, "--batch", baselineTestBatch, "--state", "all")
	if code != 0 || !strings.Contains(out, "[A3]") {
		t.Fatalf("--state all failed: %d %s", code, out)
	}
	if gotQuery != "state=all" {
		t.Fatalf("all state query: %q", gotQuery)
	}

	// --with-sections appends deduped subtrees only when requested.
	gotQuery = ""
	out, _, code = executeBaseline(t, "annotations", baselineTestProject, "--batch", baselineTestBatch, "--with-sections")
	if code != 0 {
		t.Fatalf("with-sections failed: %d", code)
	}
	if !strings.Contains(out, "--with-sections：以下为被批注小节子树") || !strings.Contains(out, "<!-- domain_rules [RULE-3] -->") {
		t.Fatalf("sections block missing:\n%s", out)
	}
	if gotQuery != "state=open&with_sections=true" {
		t.Fatalf("with_sections query: %q", gotQuery)
	}

	// JSON output passes the server payload through unchanged.
	out, _, code = executeBaseline(t, "annotations", baselineTestProject, "--batch", baselineTestBatch, "--output", "json")
	if code != 0 {
		t.Fatalf("json failed: %d", code)
	}
	payload := baselineJSON(t, out)
	if payload["batch"] == nil || payload["annotations"] == nil {
		t.Fatal("json payload missing batch/annotations")
	}

	// Issue identifier resolves through the active batch listing.
	gotPath = ""
	_, _, code = executeBaseline(t, "annotations", baselineTestProject, "--batch", "OL-1240")
	if code != 0 || gotPath == "" {
		t.Fatalf("issue-identifier batch failed: %d", code)
	}

	// Reply threads render the member name.
	out, _, _ = executeBaseline(t, "annotations", baselineTestProject, "--batch", baselineTestBatch)
	_ = out

	// Flag validation.
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"annotations", baselineTestProject}, "--batch is required"},
		{[]string{"annotations", baselineTestProject, "--batch", baselineTestBatch, "--state", "resolved"}, "open or all"},
	} {
		_, stderr, code := executeBaseline(t, tc.args...)
		if code != 2 || !strings.Contains(stderr, tc.want) {
			t.Fatalf("%v: code=%d stderr=%s", tc.args, code, stderr)
		}
	}
}

func TestLabrastroBaselineRespondCommand(t *testing.T) {
	t.Chdir(t.TempDir())
	annotations := []any{
		baselineTestAnnotation(baselineTestAnnotationID, 1, nil),
		baselineTestAnnotation("60000000-0000-4000-8000-000000000002", 2, nil),
	}
	var posted map[string]any
	var fetchedQuery string
	_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) {
		switch {
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/annotations/responses"):
			posted = body
			json.NewEncoder(w).Encode(map[string]any{"updated": 2})
		case r.Method == "GET" && strings.Contains(r.URL.Path, "/annotation-batches/"):
			fetchedQuery = r.URL.RawQuery
			json.NewEncoder(w).Encode(baselineAnnotationBatchResponse(nil, annotations, nil))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	})
	if err := os.WriteFile("responses.json", []byte(`[{"annotation":"A1","response":"已按批注补充"},{"annotation":"60000000-0000-4000-8000-000000000002","response":"uuid target"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	out, stderr, code := executeBaseline(t, "respond", baselineTestProject, "--batch", baselineTestBatch, "--responses-file", "./responses.json")
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%s", code, stderr)
	}
	if !strings.Contains(out, "已提交 2 条智能体回应") {
		t.Fatalf("output: %s", out)
	}
	if fetchedQuery != "state=all" {
		t.Fatalf("ordinal lookup must use --state all, got %q", fetchedQuery)
	}
	responses := posted["responses"].([]any)
	if len(responses) != 2 {
		t.Fatalf("posted %d responses", len(responses))
	}
	first := responses[0].(map[string]any)
	if first["annotation_id"] != baselineTestAnnotationID || first["response"] != "已按批注补充" {
		t.Fatalf("ordinal not resolved to UUID: %v", first)
	}

	// Rejection: missing flags, non-UUID batch, outside file, bad references.
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte(`[]`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("bad.json", []byte(`[{"annotation":"A9","response":"x"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"respond", baselineTestProject}, "--batch and --responses-file are required"},
		{[]string{"respond", baselineTestProject, "--batch", "OL-1240", "--responses-file", "./responses.json"}, "batch UUID"},
		{[]string{"respond", baselineTestProject, "--batch", baselineTestBatch, "--responses-file", outside}, "inside the current directory"},
		{[]string{"respond", baselineTestProject, "--batch", baselineTestBatch, "--responses-file", "./bad.json"}, "not part of batch"},
	} {
		_, stderr, code := executeBaseline(t, tc.args...)
		if code != 2 || !strings.Contains(stderr, tc.want) {
			t.Fatalf("%v: code=%d stderr=%s", tc.args, code, stderr)
		}
	}
}

func TestLabrastroBaselineAnnotationsFailureRedaction(t *testing.T) {
	t.Chdir(t.TempDir())
	_, _ = serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		w.WriteHeader(500)
		json.NewEncoder(w).Encode(map[string]any{"error": "SECRET_ANNOTATION_BODY"})
	})
	for _, args := range [][]string{
		{"annotations", baselineTestProject, "--batch", baselineTestBatch},
		{"respond", baselineTestProject, "--batch", baselineTestBatch, "--responses-file", writeResponsesFile(t)},
	} {
		out, stderr, code := executeBaseline(t, args...)
		if code != 1 || out != "" || strings.Contains(stderr, "SECRET_ANNOTATION_BODY") {
			t.Fatalf("%v: code=%d out=%q stderr=%q", args, code, out, stderr)
		}
	}
}

func writeResponsesFile(t *testing.T) string {
	t.Helper()
	if err := os.WriteFile("responses.json", []byte(`[{"annotation":"`+baselineTestAnnotationID+`","response":"ok"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	return "./responses.json"
}
