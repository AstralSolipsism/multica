package handler

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestLabrastroBaselineModulesAndSectionLifecycle(t *testing.T) {
	f := newEngineeringFixture(t)
	f.enable()
	var initial baselineRevisionResponse
	testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", map[string]any{
		"chapter": "module:billing", "chapter_title": "计费", "content_markdown": "## Pay\nUses [[Account]].\n\n## Keep\nUNRELATED_BODY\n",
	}, "task")).Want(201).JSON(&initial)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", initial), "session")).Want(200)
	term := f.propose("domain_rules", "## Account\nA customer identity.\n\n为什么：Traceability.\n\nLinks [[Indirect]].\n## Indirect\nSECOND_HOP_BODY", nil, nil)
	testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", term), "session")).Want(200)
	var overview struct {
		Chapters []baselineChapterResponse `json:"chapters"`
	}
	testutil.Call(t, testHandler.LabrastroGetEngineering, f.request("GET", "/engineering", nil, "session")).Want(200).JSON(&overview)
	if len(overview.Chapters) != 5 || overview.Chapters[4].Title != "计费" || overview.Chapters[4].Adopted == nil {
		t.Fatalf("chapters=%+v", overview.Chapters)
	}
	var index struct {
		Chapters []baselineIndexChapter `json:"chapters"`
	}
	indexResponse := testutil.Call(t, testHandler.LabrastroReadBaseline, f.request("GET", "/baseline?index=true", nil, "task")).Want(200).JSON(&index)
	raw := indexResponse.Body.Bytes()
	if len(index.Chapters) != 5 || len(index.Chapters[4].Sections) != 2 || index.Chapters[4].RevisionNumber != 1 || strings.Contains(string(raw), "UNRELATED_BODY") || strings.Contains(string(raw), "content_markdown") || strings.Contains(string(raw), "anchors_diff") {
		t.Fatalf("index=%s", raw)
	}
	var slice engineering.Slice
	testutil.Call(t, testHandler.LabrastroReadBaseline, f.request("GET", "/baseline?chapter=module:billing&section=Pay", nil, "task")).Want(200).JSON(&slice)
	raw, _ = json.Marshal(slice)
	if len(slice.Sections) != 1 || len(slice.ReferencedSections) != 1 || slice.ReferencedSections[0].Why != "Traceability." || strings.Contains(string(raw), "SECOND_HOP_BODY") || strings.Contains(string(raw), "UNRELATED_BODY") {
		t.Fatalf("slice=%s", raw)
	}
	context := testHandler.appendEngineeringProjectDescription(t.Context(), parseUUID(testWorkspaceID), parseUUID(f.project), "Original")
	if !strings.Contains(context, "module:billing（计费） v1：Pay；Keep") || !strings.Contains(context, "--section") || strings.Contains(context, "UNRELATED_BODY") {
		t.Fatalf("context=%s", context)
	}
	base := initial
	for _, tc := range []struct {
		section, content string
		deleting         bool
		want, absent     string
	}{
		{"Pay", "Updated [[Account]].", false, "## Pay\nUpdated", "Uses"},
		{"Refund", "Refund definition.", false, "## Refund\nRefund definition.", ""},
		{"Pay", "", true, "## Refund", "## Pay"},
	} {
		var next baselineRevisionResponse
		body := map[string]any{"chapter": "module:billing", "section": tc.section, "content_markdown": tc.content, "delete_section": tc.deleting, "base_revision_id": uuidToString(base.ID)}
		testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", body, "task")).Want(201).JSON(&next)
		if !strings.Contains(next.ContentMarkdown, tc.want) || tc.absent != "" && strings.Contains(next.ContentMarkdown, tc.absent) || !strings.Contains(next.ContentMarkdown, "## Keep\nUNRELATED_BODY\n") {
			t.Fatalf("next=%s", next.ContentMarkdown)
		}
		if f.readRevision(uuidToString(base.ID)).ContentMarkdown != base.ContentMarkdown {
			t.Fatal("proposal mutated adopted content")
		}
		testutil.Call(t, testHandler.LabrastroDecideBaseline, f.request("POST", "/baseline/decisions", decision("adopt", next), "session")).Want(200)
		base = next
	}
	stale := map[string]any{"chapter": "module:billing", "section": "Refund", "content_markdown": "Stale", "base_revision_id": uuidToString(initial.ID), "chapter_title": "Must roll back"}
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroProposeBaseline, f.request("POST", "/baseline/candidates", stale, "task")).Want(409), "baseline_base_stale")
	testutil.Call(t, testHandler.LabrastroGetEngineering, f.request("GET", "/engineering", nil, "session")).Want(200).JSON(&overview)
	if overview.Chapters[4].Title != "计费" {
		t.Fatal("stale proposal changed metadata")
	}
	for _, query := range []string{"", "index=true&section=Pay", "index=bad", "section=Pay&chapter=module:INVALID"} {
		testutil.Call(t, testHandler.LabrastroReadBaseline, f.request("GET", "/baseline?"+query, nil, "session")).Want(400)
	}
	wantEngineeringCode(t, testutil.Call(t, testHandler.LabrastroReadBaseline, f.request("GET", "/baseline?section="+url.QueryEscape("missing"), nil, "task")).Want(404), "baseline_section_not_found")
}
