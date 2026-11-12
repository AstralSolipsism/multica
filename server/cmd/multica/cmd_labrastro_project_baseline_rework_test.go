package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// ---------- tree text output is pre-order with H2/H3 outlines ----------

func TestLabrastroBaselineTreePreOrder(t *testing.T) {
	withTree := func(id, parent, slug, title string, number, depth int32, sections []map[string]any, archived bool) map[string]any {
		page := baselineWikiTreePage(slug, title, number, sections, archived)
		page["id"] = id
		if parent != "" {
			page["parent_id"] = parent
		}
		page["depth"] = depth
		return page
	}
	_, _ = serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		outline := []map[string]any{
			{"anchor": "top", "title": "一级不列", "level": 1},
			{"anchor": "goal", "title": "目标", "level": 2},
			{"anchor": "sub", "title": "子目标", "level": 3},
			{"anchor": "deep", "title": "四级不列", "level": 4},
		}
		baselineWriteJSON(w, 200, baselineWikiTree(
			// Deliberately shuffled: children arrive before their parents and
			// an archived page sits between live roots.
			withTree("30000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000002", "detail", "细节页", 1, 3, nil, false),
			withTree("20000000-0000-4000-8000-000000000002", baselineTestPageID, "arch", "架构", 1, 2, nil, false),
			withTree(baselineTestPageID, "", "overview", "总览", 2, 1, outline, false),
			withTree("40000000-0000-4000-8000-000000000004", "", "zeta", "泽塔", 1, 1, nil, false),
			withTree("50000000-0000-4000-8000-000000000005", "", "gone", "已归档", 1, 1, nil, true),
		))
	})
	out, stderr, code := executeBaseline(t, "tree", baselineTestProject)
	if code != 0 || stderr != "" {
		t.Fatalf("tree failed: %d %s %s", code, out, stderr)
	}
	at := map[string]int{
		"overview": strings.Index(out, "overview v2 总览\n"),
		"arch":     strings.Index(out, "  arch v1 架构\n"),
		"detail":   strings.Index(out, "    detail v1 细节页\n"),
		"zeta":     strings.Index(out, "zeta v1 泽塔\n"),
	}
	for name, index := range at {
		if index < 0 {
			t.Fatalf("tree lost %s:\n%s", name, out)
		}
	}
	// Pre-order: a child never prints before its parent, and depth drives indent.
	if !(at["overview"] < at["arch"] && at["arch"] < at["detail"] && at["detail"] < at["zeta"]) {
		t.Fatalf("tree not pre-order: %v\n%s", at, out)
	}
	// Only H2/H3 sections are outlined.
	for _, want := range []string{"  # 目标", "  # 子目标"} {
		if !strings.Contains(out, want) {
			t.Fatalf("tree outline missing %q:\n%s", want, out)
		}
	}
	for _, unwanted := range []string{"一级不列", "四级不列", "gone v1"} {
		if strings.Contains(out, unwanted) {
			t.Fatalf("tree must not list %q:\n%s", unwanted, out)
		}
	}
}

// ---------- rename/move request bodies carry the base and the exact flags ----------

func TestLabrastroBaselineRenameMoveBodies(t *testing.T) {
	_, calls := serveBaseline(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		baselineWriteJSON(w, 200, baselineWikiWriteResult("mv", "移动页", 2, "move", "正文", false))
	})

	// move --root sends parent:null and succeeds.
	out, stderr, code := executeBaseline(t, "move", baselineTestProject, "--page", "mv", "--base", "3", "--root")
	if code != 0 || stderr != "" || !strings.Contains(out, "moved: mv v2") {
		t.Fatalf("move --root: %d %q %q", code, out, stderr)
	}
	body := calls()[0].Body
	if value, ok := body["parent"]; !ok || value != nil {
		t.Fatalf("--root must send parent:null: %+v", body)
	}
	if body["base_revision_number"] != float64(3) {
		t.Fatalf("move body lost base_revision_number: %+v", body)
	}
	if _, ok := body["after"]; ok {
		t.Fatalf("--root must not send after: %+v", body)
	}

	// move --after only reorders inside the current parent; no parent key.
	out, _, code = executeBaseline(t, "move", baselineTestProject, "--page", "mv", "--base", "4", "--after", "sibling")
	if code != 0 || !strings.Contains(out, "moved: mv v2") {
		t.Fatalf("move --after: %d %q", code, out)
	}
	body = calls()[1].Body
	if _, ok := body["parent"]; ok {
		t.Fatalf("--after only must not send parent: %+v", body)
	}
	if body["after"] != "sibling" || body["base_revision_number"] != float64(4) {
		t.Fatalf("move --after body: %+v", body)
	}

	// move --first sends after:"first".
	out, _, code = executeBaseline(t, "move", baselineTestProject, "--page", "mv", "--base", "5", "--first")
	if code != 0 || !strings.Contains(out, "moved: mv v2") {
		t.Fatalf("move --first: %d %q", code, out)
	}
	body = calls()[2].Body
	if body["after"] != "first" {
		t.Fatalf("--first must send after:\"first\": %+v", body)
	}
	if _, ok := body["parent"]; ok {
		t.Fatalf("--first must not send parent: %+v", body)
	}

	// rename carries base_revision_number too.
	out, _, code = executeBaseline(t, "rename", baselineTestProject, "--page", "mv", "--base", "7", "--title", "改名")
	if code != 0 || !strings.Contains(out, "renamed: mv v2") {
		t.Fatalf("rename: %d %q", code, out)
	}
	if body := calls()[3].Body; body["base_revision_number"] != float64(7) || body["title"] != "改名" {
		t.Fatalf("rename body: %+v", body)
	}
}

// ---------- non-conflict 409s exit 1, never the conflict code 3 ----------

func TestLabrastroBaselineNonConflictFailure(t *testing.T) {
	file := writeBaselineInput(t, "正文")
	_, _ = serveBaseline(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.WriteHeader(409)
		json.NewEncoder(w).Encode(map[string]any{"code": "baseline_slug_taken", "error": "slug taken"})
	})
	for _, args := range [][]string{
		{"rename", baselineTestProject, "--page", "p", "--base", "1", "--slug", "taken"},
		{"move", baselineTestProject, "--page", "p", "--base", "1", "--parent", "taken-parent"},
		{"write", baselineTestProject, "--page", "p", "--base", "1", "--content-file", file},
	} {
		out, stderr, code := executeBaseline(t, args...)
		if code != 1 || out != "" {
			t.Fatalf("%v: exit=%d out=%q (only baseline_conflict may exit 3)", args, code, out)
		}
		if !strings.Contains(stderr, "baseline_slug_taken") {
			t.Fatalf("%v: stderr=%q", args, stderr)
		}
	}
}
