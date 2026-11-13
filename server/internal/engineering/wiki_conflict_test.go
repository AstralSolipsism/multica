package engineering_test

import (
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestWikiRevisionConflictMatrix(t *testing.T) {
	base := db.ProjectBaselineRevision{RevisionNumber: 1, ContentMarkdown: "## Rules\nkeep\n"}
	current := base
	current.RevisionNumber = 3
	for _, tc := range []struct {
		kind    string
		allowed []string
	}{
		{"content", []string{"rename", "move"}},
		{"section", []string{"content", "rename", "move"}},
		{"rename", []string{"content", "move"}},
		{"move", []string{"content", "rename"}},
		{"archive", nil}, {"restore", nil}, {"rollback", nil},
	} {
		for _, intervening := range []string{"content", "rename", "move", "archive", "restore", "rollback"} {
			t.Run(tc.kind+"/"+intervening, func(t *testing.T) {
				// A later orthogonal revision must not hide an earlier conflict.
				window := []db.ProjectBaselineRevision{{RevisionKind: intervening}, {RevisionKind: "create"}}
				want := !slices.Contains(tc.allowed, intervening)
				if got, err := engineering.WikiRevisionConflict(tc.kind, base, current, window, "Rules"); err != nil || got != want {
					t.Fatalf("conflict = %v, %v; want %v", got, err, want)
				}
				if got, err := engineering.WikiRevisionConflict(tc.kind, current, current, nil, "Rules"); err != nil || got {
					t.Fatalf("current base conflicts: %v, %v", got, err)
				}
			})
		}
	}
	current.ParentID = wikiID(1)
	if got, err := engineering.WikiRevisionConflict("move", base, current, nil, ""); err != nil || !got {
		t.Fatalf("parent mismatch must conflict even without a move in the window: %v, %v", got, err)
	}
}

func TestWikiSectionConflict(t *testing.T) {
	const before = "## Rules\nkeep\n### Child\nchild\n## Other\nold\n"
	for _, tc := range []struct {
		name, base, current, kind, code string
		conflict                        bool
	}{
		{"orthogonal section", before, "## Rules\nkeep\n### Child\nchild\n## Other\nnew\n", "content", "", false},
		{"subtree changed", before, "## Rules\nkeep\n### Child\nchanged\n", "content", "", true},
		{"whitespace changed", before, "## Rules\nkeep \n### Child\nchild\n", "content", "", true},
		{"base section missing", "## Other\nold\n", before, "content", "baseline_section_not_found", false},
		{"current section missing", before, "## Other\nold\n", "content", "baseline_section_not_found", false},
		{"archive wins over missing section", before, "", "archive", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := db.ProjectBaselineRevision{RevisionNumber: 1, ContentMarkdown: tc.base}
			current := db.ProjectBaselineRevision{RevisionNumber: 2, ContentMarkdown: tc.current}
			got, err := engineering.WikiRevisionConflict("section", base, current, []db.ProjectBaselineRevision{{RevisionKind: tc.kind}}, "Rules")
			if tc.code != "" {
				var invalid *engineering.Error
				if !errors.As(err, &invalid) || invalid.Code != tc.code {
					t.Fatalf("error = %v, want %s", err, tc.code)
				}
			} else if err != nil || got != tc.conflict {
				t.Fatalf("conflict = %v, %v; want %v", got, err, tc.conflict)
			}
		})
	}
}

func TestWikiStructureDiff(t *testing.T) {
	old := db.ProjectBaselineRevision{Title: "Old", Slug: "old", ParentID: wikiID(1), Position: 2}
	pages := []db.ProjectBaselinePage{{ID: wikiID(1), Slug: "parent"}}
	for _, tc := range []struct {
		name string
		next db.ProjectBaselineRevision
		want map[string]engineering.WikiStructureChange
	}{
		{"unchanged", old, map[string]engineering.WikiStructureChange{}},
		{"all fields", db.ProjectBaselineRevision{Title: "New", Slug: "new", ParentID: wikiID(2), Position: 1, ArchivedAt: pgtype.Timestamptz{Valid: true}}, map[string]engineering.WikiStructureChange{
			"title": {From: "Old", To: "New"}, "slug": {From: "old", To: "new"},
			"parent":   {From: "parent", To: util.UUIDToString(wikiID(2))},
			"position": {From: int32(2), To: int32(1)}, "archived": {From: false, To: true},
		}},
		{"root parent", db.ProjectBaselineRevision{Title: "Old", Slug: "old", Position: 2}, map[string]engineering.WikiStructureChange{
			"parent": {From: "parent", To: ""},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := engineering.WikiStructureDiff(pages, old, tc.next); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("diff = %#v, want %#v", got, tc.want)
			}
		})
	}
	old.ArchivedAt = pgtype.Timestamptz{Time: time.Unix(1, 0), Valid: true}
	next := old
	next.ArchivedAt.Time = time.Unix(2, 0)
	next.ContentMarkdown = "body-only change"
	if got := engineering.WikiStructureDiff(pages, old, next); len(got) != 0 {
		t.Fatalf("timestamps and content are not structure changes: %v", got)
	}
}
