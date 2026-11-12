package handler

import (
	"net/url"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Endpoint coverage for the review-round additions: history pagination, the
// single-revision read, the structure/sections diff and the backlinks index.

type baselineWikiHistoryOut struct {
	Revisions  []wikiRevisionResponse `json:"revisions"`
	HasMore    bool                   `json:"has_more"`
	NextBefore *int32                 `json:"next_before"`
}

type baselineWikiRevisionOut struct {
	Page     wikiPageResponse     `json:"page"`
	Revision wikiRevisionResponse `json:"revision"`
}

type baselineWikiDiffOut struct {
	Structure map[string]wikiStructureChange `json:"structure"`
	Sections  engineering.Diff               `json:"sections"`
}

func (f baselineWikiFixture) tryHistory(page, query string) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroWikiPageHistory, f.request("session", "GET", "/baseline/pages/"+page+"/revisions"+query, nil, map[string]string{"page": page}))
}

func (f baselineWikiFixture) history(page, query string) baselineWikiHistoryOut {
	f.t.Helper()
	var out baselineWikiHistoryOut
	f.tryHistory(page, query).Want(200).JSON(&out)
	return out
}

func (f baselineWikiFixture) tryRevision(page, n string) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroWikiPageRevision, f.request("session", "GET", "/baseline/pages/"+page+"/revisions/"+n, nil, map[string]string{"page": page, "n": n}))
}

func (f baselineWikiFixture) tryDiff(page, query string) *testutil.Response {
	f.t.Helper()
	return testutil.Call(f.t, testHandler.LabrastroWikiPageDiff, f.request("session", "GET", "/baseline/pages/"+page+"/diff"+query, nil, map[string]string{"page": page}))
}

func (f baselineWikiFixture) diff(page, query string) baselineWikiDiffOut {
	f.t.Helper()
	var out baselineWikiDiffOut
	f.tryDiff(page, query).Want(200).JSON(&out)
	return out
}

func (f baselineWikiFixture) backlinks(page string) []engineering.Backlink {
	f.t.Helper()
	var out struct {
		Backlinks []engineering.Backlink `json:"backlinks"`
	}
	testutil.Call(f.t, testHandler.LabrastroWikiPageBacklinks, f.request("session", "GET", "/baseline/pages/"+page+"/backlinks", nil, map[string]string{"page": page})).Want(200).JSON(&out)
	return out.Backlinks
}

// ---------- 12. history / revision / diff / backlinks endpoints ----------

func TestLabrastroBaselineWikiHistoryRevisionDiffBacklinks(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()

	f.create("session", "史父", "hist-parent", nil, nil, "父正文")
	f.create("session", "史页", "hist-page", nil, nil, "## 甲\n甲文 v1\n## 乙\n乙文 v1")                                  // v1, root position 1
	f.tryPatch("task", "hist-page", map[string]any{"base_revision_number": 1, "parent": "hist-parent"}).Want(200) // v2 move
	f.tryPatch("session", "hist-page", map[string]any{"base_revision_number": 2, "title": "史页改"}).Want(200)       // v3 rename
	f.fullWrite("task", "hist-page", 3, "## 甲\n甲文 v2\n## 乙\n乙文 v1\n## 丙\n丙文")                                     // v4
	f.fullWrite("session", "hist-page", 4, "## 甲\n甲文 v2\n## 乙\n乙文 v2")                                            // v5

	t.Run("pagination strips bodies and pages by before", func(t *testing.T) {
		first := f.history("hist-page", "?limit=2&with_content=false")
		if len(first.Revisions) != 2 || first.Revisions[0].RevisionNumber != 5 || first.Revisions[1].RevisionNumber != 4 {
			t.Fatalf("first page: %+v", first.Revisions)
		}
		if !first.HasMore || first.NextBefore == nil || *first.NextBefore != 4 {
			t.Fatalf("has_more/next_before: %+v", first)
		}
		for _, revision := range first.Revisions {
			if revision.ContentMarkdown != "" {
				t.Fatalf("with_content=false must strip bodies: %+v", revision)
			}
			if revision.ChangeSummary == "" || revision.CreatedByType == "" {
				t.Fatalf("summaries lost metadata: %+v", revision)
			}
		}
		second := f.history("hist-page", "?limit=2&before=4&with_content=false")
		if len(second.Revisions) != 2 || second.Revisions[0].RevisionNumber != 3 || second.Revisions[1].RevisionNumber != 2 ||
			!second.HasMore || second.NextBefore == nil || *second.NextBefore != 2 {
			t.Fatalf("second page: %+v", second)
		}
		last := f.history("hist-page", "?limit=2&before=2&with_content=false")
		if len(last.Revisions) != 1 || last.Revisions[0].RevisionNumber != 1 || last.HasMore || last.NextBefore != nil {
			t.Fatalf("last page: %+v", last)
		}
		// Bodies ride along unless with_content=false asks for summaries.
		full := f.history("hist-page", "")
		if len(full.Revisions) != 5 || full.Revisions[0].ContentMarkdown == "" || full.HasMore {
			t.Fatalf("default history: %+v", full)
		}
	})

	t.Run("pagination query validation", func(t *testing.T) {
		for _, query := range []string{"?limit=0", "?limit=-1", "?limit=abc", "?before=0", "?before=abc", "?with_content=yes", "?with_content=1"} {
			wantBaselineWikiCode(t, f.tryHistory("hist-page", query), 400, "invalid_request")
		}
	})

	t.Run("single revision carries content", func(t *testing.T) {
		var out baselineWikiRevisionOut
		f.tryRevision("hist-page", "3").Want(200).JSON(&out)
		if out.Revision.RevisionNumber != 3 || out.Revision.RevisionKind != "rename" || out.Revision.Title != "史页改" {
			t.Fatalf("revision 3: %+v", out.Revision)
		}
		if out.Revision.ContentMarkdown != "## 甲\n甲文 v1\n## 乙\n乙文 v1" {
			t.Fatalf("single revision lost content: %q", out.Revision.ContentMarkdown)
		}
		if out.Page.Slug != "hist-page" || out.Page.Title != "史页改" || out.Page.CurrentRevisionNumber != 5 {
			t.Fatalf("page row: %+v", out.Page)
		}
		wantBaselineWikiCode(t, f.tryRevision("hist-page", "99"), 404, "not_found")
		wantBaselineWikiCode(t, f.tryRevision("hist-page", "0"), 400, "invalid_request")
		wantBaselineWikiCode(t, f.tryRevision("hist-page", "x"), 400, "invalid_request")
	})

	t.Run("diff reports only changed structure with slug parents", func(t *testing.T) {
		whole := f.diff("hist-page", "?from=1&to=5")
		if len(whole.Structure) != 3 {
			t.Fatalf("structure must list only title/parent/position: %+v", whole.Structure)
		}
		if change, ok := whole.Structure["title"]; !ok || change.From != "史页" || change.To != "史页改" {
			t.Fatalf("title change: %+v", whole.Structure["title"])
		}
		if change, ok := whole.Structure["parent"]; !ok || change.From != "" || change.To != "hist-parent" {
			t.Fatalf("parent change must use slugs, not UUIDs: %+v", whole.Structure["parent"])
		}
		if change, ok := whole.Structure["position"]; !ok || change.From != float64(1) || change.To != float64(0) {
			t.Fatalf("position change: %+v", whole.Structure["position"])
		}
		if _, ok := whole.Structure["slug"]; ok {
			t.Fatal("slug never changed between v1 and v5")
		}
		if _, ok := whole.Structure["archived"]; ok {
			t.Fatal("archived never changed between v1 and v5")
		}
		if len(whole.Sections.Modified) != 2 || len(whole.Sections.Added) != 0 || len(whole.Sections.Removed) != 0 {
			t.Fatalf("v1→v5 sections: %+v", whole.Sections)
		}
		titles := map[string]bool{}
		for _, change := range whole.Sections.Modified {
			titles[change.Title] = true
		}
		if !titles["甲"] || !titles["乙"] {
			t.Fatalf("modified sections: %+v", whole.Sections.Modified)
		}

		growth := f.diff("hist-page", "?from=1&to=4")
		if len(growth.Sections.Added) != 1 || growth.Sections.Added[0].Title != "丙" || growth.Sections.UnchangedCount != 1 {
			t.Fatalf("v1→v4 sections: %+v", growth.Sections)
		}
		shrink := f.diff("hist-page", "?from=4&to=5")
		if len(shrink.Sections.Removed) != 1 || shrink.Sections.Removed[0].Title != "丙" || len(shrink.Sections.Modified) != 1 {
			t.Fatalf("v4→v5 sections: %+v", shrink.Sections)
		}

		current := f.diff("hist-page", "?from=4") // to defaults to the current revision
		if len(current.Structure) != 0 || len(current.Sections.Removed) != 1 {
			t.Fatalf("implicit to=current: %+v", current)
		}

		wantBaselineWikiCode(t, f.tryDiff("hist-page", "?from=0"), 400, "invalid_request")
		wantBaselineWikiCode(t, f.tryDiff("hist-page", "?from=abc"), 400, "invalid_request")
		wantBaselineWikiCode(t, f.tryDiff("hist-page", "?from=1&to=0"), 400, "invalid_request")
		wantBaselineWikiCode(t, f.tryDiff("hist-page", "?from=99"), 404, "not_found")
	})

	t.Run("backlinks list resolved inbound links and exclude self", func(t *testing.T) {
		f.create("session", "反链目标", "bl-target", nil, nil, "## 目标节\n目标正文")
		f.create("session", "反链来源", "bl-source", nil, nil, "## 来源节\n引用 [[bl-target]] 与 [[bl-target#目标节]]。\n自引 [[bl-source]] 不算。")
		links := f.backlinks("bl-target")
		if len(links) != 2 {
			t.Fatalf("both resolved inbound links must list: %+v", links)
		}
		for _, link := range links {
			if link.Slug != "bl-source" || !strings.Contains(link.Snippet, "[[bl-target") {
				t.Fatalf("backlink: %+v", link)
			}
		}
		if links[1].SectionAnchor == "" {
			t.Fatalf("section link lost its anchor: %+v", links[1])
		}
		target := f.currentPage("bl-target")
		if byUUID := f.backlinks(target.ID); len(byUUID) != 2 {
			t.Fatalf("backlinks by UUID: %+v", byUUID)
		}
		if self := f.backlinks("bl-source"); len(self) != 0 {
			t.Fatalf("own links must be excluded: %+v", self)
		}
	})
}

// ---------- 13. mutation survivors (review G7 / G11 / G13) ----------

func TestLabrastroBaselineWikiMutationSurvivors(t *testing.T) {
	t.Run("recursive restore covers the same batch only", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "批父", "g7-parent", nil, nil, "正文")
		f.create("session", "同批子", "g7-batch", new("g7-parent"), nil, "正文")
		f.create("session", "单独子", "g7-solo", new("g7-parent"), nil, "正文")
		// The solo child archives first, in its own batch.
		f.flip("session", "g7-solo", 1, nil, true)
		// The recursive archive flips only the parent and the still-live child.
		archived := f.flip("session", "g7-parent", 1, map[string]any{"recursive": true}, true)
		if len(archived.Pages) != 2 {
			t.Fatalf("recursive archive flipped %+v", archived.Pages)
		}
		// Force the two batches apart so the timestamps cannot collide.
		dbfx.Exec(t, `UPDATE project_baseline_page SET archived_at = archived_at - interval '1 hour'
			WHERE workspace_id=$1 AND project_id=$2 AND slug='g7-solo'`, testWorkspaceID, f.project)

		restored := f.flip("task", "g7-parent", f.currentPage("g7-parent").CurrentRevisionNumber, map[string]any{"recursive": true}, false)
		if len(restored.Pages) != 2 {
			t.Fatalf("recursive restore flipped %+v", restored.Pages)
		}
		flipped := map[string]bool{}
		for _, item := range restored.Pages {
			flipped[item.Page.Slug] = true
			if item.Page.ArchivedAt != nil || item.Revision.RevisionKind != "restore" {
				t.Fatalf("restore result: %+v", item)
			}
			assertSnapshot(t, item)
		}
		if !flipped["g7-parent"] || !flipped["g7-batch"] {
			t.Fatalf("same-batch child must restore: %+v", flipped)
		}
		if flipped["g7-solo"] || f.currentPage("g7-solo").ArchivedAt == nil {
			t.Fatalf("separately archived child must stay archived: %+v", f.tree().Pages)
		}
		assertDensePositions(t, f.tree().Pages)

		// The solo child still restores afterwards, in its original slot.
		f.flip("session", "g7-solo", f.currentPage("g7-solo").CurrentRevisionNumber, nil, false)
		if f.currentPage("g7-solo").ArchivedAt != nil {
			t.Fatal("solo child failed to restore")
		}
		assertDensePositions(t, f.tree().Pages)
	})

	t.Run("full rollback of an archived page ends unarchived", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "归档回滚页", "g11-page", nil, nil, "正文一")
		f.fullWrite("session", "g11-page", 1, "正文二")
		f.flip("session", "g11-page", 2, nil, true)
		if f.currentPage("g11-page").ArchivedAt == nil {
			t.Fatal("setup: page not archived")
		}
		var out baselineWikiWriteOut
		f.tryRollback("task", "g11-page", map[string]any{
			"revision_number": 1, "base_revision_number": f.currentPage("g11-page").CurrentRevisionNumber,
		}).Want(201).JSON(&out)
		if out.Page.ArchivedAt != nil || out.Revision.ArchivedAt != nil {
			t.Fatalf("rollback must end unarchived: %+v", out)
		}
		if out.Revision.RevisionKind != "rollback" || out.Revision.ContentMarkdown != "正文一" || out.Revision.RestoredFromRevisionID == nil {
			t.Fatalf("rollback revision: %+v", out.Revision)
		}
		assertSnapshot(t, out)
		if f.currentPage("g11-page").ArchivedAt != nil {
			t.Fatalf("tree still archives the page: %+v", f.currentPage("g11-page"))
		}
	})

	t.Run("full rollback restores the vN position with sibling reflow", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "位甲", "g13-a", nil, nil, "正文")
		f.create("session", "位乙", "g13-b", nil, nil, "正文")
		f.tryPatch("session", "g13-a", map[string]any{"base_revision_number": 1, "after": "g13-b"}).Want(200) // v2: b0 a1
		f.fullWrite("task", "g13-a", 2, "正文 v3")                                                              // v3
		var out baselineWikiWriteOut
		f.tryRollback("session", "g13-a", map[string]any{"revision_number": 1, "base_revision_number": 3}).Want(201).JSON(&out)
		if out.Page.Position != 0 {
			t.Fatalf("position=%d want the v1 slot 0, not append-to-end", out.Page.Position)
		}
		if got := f.currentPage("g13-b"); got.Position != 1 {
			t.Fatalf("sibling not reflowed: %+v", got)
		}
		assertDensePositions(t, f.tree().Pages)
	})

	t.Run("full rollback clamps the vN position into the current set", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "夹家", "g13-home", nil, nil, "正文")
		f.create("session", "夹甲", "g13-x", nil, nil, "正文")
		f.create("session", "夹乙", "g13-y", nil, nil, "正文")
		f.create("session", "夹丙", "g13-z", nil, nil, "正文")
		f.tryPatch("session", "g13-x", map[string]any{"base_revision_number": 1, "after": "g13-z"}).Want(200) // v2: home0 y1 z2 x3
		f.tryPatch("task", "g13-y", map[string]any{"base_revision_number": 1, "parent": "g13-home"}).Want(200)
		f.fullWrite("session", "g13-x", 2, "正文 v3") // v3
		var out baselineWikiWriteOut
		f.tryRollback("session", "g13-x", map[string]any{"revision_number": 2, "base_revision_number": 3}).Want(201).JSON(&out)
		// v2 recorded position 3, but only home and z remain at the root.
		if out.Page.Position != 2 {
			t.Fatalf("position=%d want the clamped end 2", out.Page.Position)
		}
		if got := f.currentPage("g13-home"); got.Position != 0 {
			t.Fatalf("home: %+v", got)
		}
		if got := f.currentPage("g13-z"); got.Position != 1 {
			t.Fatalf("z: %+v", got)
		}
		assertDensePositions(t, f.tree().Pages)
	})
}

// ---------- 14. rebase matrix gaps (contract §5.3) ----------

func TestLabrastroBaselineWikiRebaseMatrixGaps(t *testing.T) {
	t.Run("stale section write rebases over a full write that kept the section", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "整页改他节", "mx-full", nil, nil, "## 甲\n甲文\n## 乙\n乙文")
		f.fullWrite("task", "mx-full", 1, "## 甲\n甲文\n## 乙\n乙文改")
		var out baselineWikiWriteOut
		f.tryWrite("session", "mx-full", map[string]any{
			"base_revision_number": 1, "section": "甲", "content_markdown": "## 甲\n甲文改",
		}).Want(200).JSON(&out)
		if !out.Rebased || out.Revision.RevisionNumber != 3 {
			t.Fatalf("stale section write over an untouched section must rebase: %+v", out)
		}
		read := f.readPage("mx-full", "").Content
		for _, want := range []string{"甲文改", "乙文改"} {
			if !strings.Contains(read, want) {
				t.Fatalf("merged content missing %q: %q", want, read)
			}
		}
	})

	t.Run("content-only rollback keeps the live position", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "锚页", "mx-anchor", nil, nil, "正文")
		f.create("session", "位页", "mx-pos", nil, nil, "正文一") // v1 records root position 1
		f.tryPatch("task", "mx-anchor", map[string]any{"base_revision_number": 1, "after": "mx-pos"}).Want(200)
		f.fullWrite("session", "mx-pos", 1, "正文三") // v2; live position is now 0
		var out baselineWikiWriteOut
		f.tryRollback("session", "mx-pos", map[string]any{
			"revision_number": 1, "base_revision_number": 2, "content_only": true,
		}).Want(201).JSON(&out)
		if out.Page.Position != 0 || out.Revision.Position != 0 {
			t.Fatalf("content-only rollback must keep the live position: page=%d rev=%d", out.Page.Position, out.Revision.Position)
		}
		if out.Revision.ContentMarkdown != "正文一" || out.Page.ParentID != nil {
			t.Fatalf("content-only rollback: %+v", out)
		}
		assertSnapshot(t, out)
		assertDensePositions(t, f.tree().Pages)
	})

	t.Run("in-place restore returns to the original slot", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "原甲", "ir-a", nil, nil, "正文")
		f.create("session", "原乙", "ir-b", nil, nil, "正文")
		f.create("session", "原丙", "ir-c", nil, nil, "正文")
		f.flip("session", "ir-b", 1, nil, true)
		restored := f.flip("task", "ir-b", f.currentPage("ir-b").CurrentRevisionNumber, nil, false)
		if len(restored.Pages) != 1 || restored.Pages[0].Page.Position != 1 || restored.Pages[0].Page.ParentID != nil {
			t.Fatalf("in-place restore: %+v", restored.Pages)
		}
		assertSnapshot(t, restored.Pages[0])
		if got := f.currentPage("ir-a"); got.Position != 0 {
			t.Fatalf("ir-a: %+v", got)
		}
		if got := f.currentPage("ir-c"); got.Position != 2 {
			t.Fatalf("ir-c: %+v", got)
		}
		assertDensePositions(t, f.tree().Pages)
	})
}

// ---------- 15. review-round move / restore / rename regressions ----------

func TestLabrastroBaselineWikiMoveRestoreRegressions(t *testing.T) {
	// Review #2/#5: a backward move inside the same parent (after only, no
	// parent key) must land exactly after the anchor.
	t.Run("backward move inside the same parent", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "移甲", "rw-a", nil, nil, "正文")
		f.create("session", "移乙", "rw-b", nil, nil, "正文")
		f.create("session", "移丙", "rw-c", nil, nil, "正文")
		f.create("session", "移丁", "rw-d", nil, nil, "正文")
		var out baselineWikiWriteOut
		f.tryPatch("task", "rw-a", map[string]any{"base_revision_number": 1, "after": "rw-b"}).Want(200).JSON(&out)
		if out.Rebased {
			t.Fatal("fresh base must not rebase")
		}
		for slug, position := range map[string]int32{"rw-b": 0, "rw-a": 1, "rw-c": 2, "rw-d": 3} {
			if got := f.currentPage(slug); got.Position != position {
				t.Fatalf("%s position=%d want %d (tree %+v)", slug, got.Position, position, f.tree().Pages)
			}
		}
		for _, slug := range []string{"rw-b", "rw-c", "rw-d"} {
			if got := revisionCount(t, f.project, slug); got != 1 {
				t.Fatalf("%s disturbed by the sibling move: %d revisions", slug, got)
			}
		}
		assertDensePositions(t, f.tree().Pages)
	})

	t.Run("parent null root and absent mean different things", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "移家", "rw-home", nil, nil, "正文")
		f.create("session", "移子", "rw-child", new("rw-home"), nil, "正文")
		f.create("session", "移子二", "rw-child-2", new("rw-home"), nil, "正文")
		var out baselineWikiWriteOut
		f.tryPatch("session", "rw-child", map[string]any{"base_revision_number": 1, "parent": nil}).Want(200).JSON(&out)
		if out.Page.ParentID != nil || out.Page.Position != 1 {
			t.Fatalf("parent:null must move to the top level: %+v", out.Page)
		}
		f.tryPatch("task", "rw-child", map[string]any{"base_revision_number": 2, "parent": "rw-home"}).Want(200)
		f.tryPatch("session", "rw-child", map[string]any{"base_revision_number": 3, "parent": "root"}).Want(200).JSON(&out)
		if out.Page.ParentID != nil {
			t.Fatalf("parent:\"root\" must move to the top level: %+v", out.Page)
		}
		// An absent parent key only reorders; the parent itself is kept.
		f.tryPatch("task", "rw-child-2", map[string]any{"base_revision_number": 1, "after": "first"}).Want(200).JSON(&out)
		home := f.currentPage("rw-home")
		if out.Page.ParentID == nil || *out.Page.ParentID != home.ID || out.Page.Position != 0 {
			t.Fatalf("absent parent must keep the parent: %+v", out.Page)
		}
		assertDensePositions(t, f.tree().Pages)
	})

	// Review #3: restore --parent appends to the END of the new sibling set
	// and leaves both sets dense.
	t.Run("restore with parent appends to the new set", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "还一家", "rr-p1", nil, nil, "正文")
		f.create("session", "还二家", "rr-p2", nil, nil, "正文")
		f.create("session", "还子一", "rr-c1", new("rr-p1"), nil, "正文")
		f.create("session", "还子二", "rr-c2", new("rr-p1"), nil, "正文")
		f.create("session", "还孙一", "rr-d1", new("rr-p2"), nil, "正文")
		f.flip("session", "rr-p1", 1, map[string]any{"recursive": true}, true)
		restored := f.flip("task", "rr-c1", f.currentPage("rr-c1").CurrentRevisionNumber, map[string]any{"parent": "rr-p2"}, false)
		if len(restored.Pages) != 1 {
			t.Fatalf("restore with parent: %+v", restored.Pages)
		}
		p2 := f.currentPage("rr-p2")
		if restored.Pages[0].Page.ParentID == nil || *restored.Pages[0].Page.ParentID != p2.ID {
			t.Fatalf("restore did not reparent: %+v", restored.Pages[0].Page)
		}
		if restored.Pages[0].Page.Position != 1 {
			t.Fatalf("restored page must join the END of the new set: %+v", restored.Pages[0].Page)
		}
		if got := f.currentPage("rr-d1"); got.Position != 0 {
			t.Fatalf("destination set not reflowed dense: %+v", got)
		}
		c2 := f.currentPage("rr-c2")
		if c2.Position != 0 || c2.ParentID == nil || *c2.ParentID != f.currentPage("rr-p1").ID {
			t.Fatalf("origin set not reflowed dense: %+v", c2)
		}
		if f.currentPage("rr-p1").ArchivedAt == nil {
			t.Fatal("the archived parent must stay archived")
		}
		assertDensePositions(t, f.tree().Pages)
	})

	// Review #4: rename summaries capture the pre-mutation names.
	t.Run("rename summaries carry old and new", func(t *testing.T) {
		f := newBaselineWikiFixture(t)
		f.enable()
		f.create("session", "旧题", "rw-sum", nil, nil, "正文")
		var out baselineWikiWriteOut
		f.tryPatch("task", "rw-sum", map[string]any{"base_revision_number": 1, "title": "新题"}).Want(200).JSON(&out)
		if summary := out.Revision.ChangeSummary; !strings.Contains(summary, "「旧题」→「新题」") {
			t.Fatalf("title rename summary=%q", summary)
		}
		f.tryPatch("session", "rw-sum", map[string]any{"base_revision_number": 2, "slug": "rw-sum-2"}).Want(200).JSON(&out)
		if summary := out.Revision.ChangeSummary; !strings.Contains(summary, "改 slug「rw-sum」→「rw-sum-2」") {
			t.Fatalf("slug-only rename summary=%q", summary)
		}
		f.tryPatch("task", "rw-sum-2", map[string]any{"base_revision_number": 3, "title": "又新题", "slug": "rw-sum-3"}).Want(200).JSON(&out)
		if summary := out.Revision.ChangeSummary; !strings.Contains(summary, "「新题」→「又新题」") || !strings.Contains(summary, "slug rw-sum-2 → rw-sum-3") {
			t.Fatalf("title+slug rename summary=%q", summary)
		}
	})
}

// ---------- 16. cross-page section reads (review #7) ----------

func TestLabrastroBaselineWikiSectionReadsCrossPage(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	f.create("session", "术语页", "sec-terms", nil, nil, "## 术语甲\n甲的定义正文。\n\n为什么：为了甲。")
	created := f.create("session", "使用页", "sec-use", nil, nil, "## 用法\n依赖 [[sec-terms#术语甲]]。\n## 其他\n其他正文")
	// v2 drops the reference from the live body.
	f.fullWrite("session", "sec-use", created.Revision.RevisionNumber, "## 用法\n不再引用。\n## 其他\n其他正文")

	read := func(query string) engineering.Slice {
		f.t.Helper()
		var out engineering.Slice
		testutil.Call(f.t, testHandler.LabrastroReadWikiPage, f.request("session", "GET", "/baseline/pages/sec-use"+query, nil, map[string]string{"page": "sec-use"})).Want(200).JSON(&out)
		return out
	}

	current := read("?section=" + url.QueryEscape("用法"))
	if len(current.Sections) != 1 || current.Sections[0].Title != "用法" ||
		!strings.Contains(current.Sections[0].ContentMarkdown, "不再引用") {
		t.Fatalf("current sections: %+v", current.Sections)
	}
	if len(current.ReferencedSections) != 0 {
		t.Fatalf("v2 body carries no refs: %+v", current.ReferencedSections)
	}

	historical := read("?revision=1&section=" + url.QueryEscape("用法"))
	if len(historical.Sections) != 1 ||
		!strings.Contains(historical.Sections[0].ContentMarkdown, "[[sec-terms#术语甲]]") {
		t.Fatalf("historical sections must read the requested revision: %+v", historical.Sections)
	}
	if len(historical.ReferencedSections) != 1 {
		t.Fatalf("one-hop refs must resolve: %+v", historical.ReferencedSections)
	}
	ref := historical.ReferencedSections[0]
	if ref.Page != "sec-terms" || ref.Title != "术语甲" {
		t.Fatalf("referenced section must come from the other page: %+v", ref)
	}
	if !strings.Contains(ref.Definition, "甲的定义正文") || !strings.Contains(ref.Why, "为了甲") {
		t.Fatalf("referenced definition/why: %+v", ref)
	}
}

// ---------- 17. rune-based snippets (review #8) ----------

func TestLabrastroBaselineWikiRuneSnippets(t *testing.T) {
	f := newBaselineWikiFixture(t)
	f.enable()
	pad, tail := strings.Repeat("前", 80), strings.Repeat("后", 80)
	f.create("session", "片段页", "snip-page", nil, nil, "## 片段节\n"+pad+"needle"+tail)
	f.create("session", "反链页", "snip-linker", nil, nil, "## 链节\n"+pad+"指向 [[snip-page]]"+tail)

	var search struct {
		Results []engineering.SearchHit `json:"results"`
	}
	testutil.Call(t, testHandler.LabrastroWikiSearch, f.request("session", "GET", "/baseline/search?q=needle", nil, nil)).Want(200).JSON(&search)
	if len(search.Results) != 1 || search.Results[0].Match != "body" || search.Results[0].Slug != "snip-page" {
		t.Fatalf("body search: %+v", search.Results)
	}
	if snippet := search.Results[0].Snippet; !strings.Contains(snippet, "needle") || utf8.RuneCountInString(snippet) < 100 {
		t.Fatalf("±60 rune window broken on a CJK body: %d runes %q", utf8.RuneCountInString(snippet), snippet)
	}

	links := f.backlinks("snip-page")
	if len(links) != 1 || links[0].Slug != "snip-linker" {
		t.Fatalf("backlinks: %+v", links)
	}
	if snippet := links[0].Snippet; !strings.Contains(snippet, "[[snip-page]]") || utf8.RuneCountInString(snippet) < 100 {
		t.Fatalf("±60 rune window broken on a CJK backlink: %d runes %q", utf8.RuneCountInString(snippet), snippet)
	}
}
