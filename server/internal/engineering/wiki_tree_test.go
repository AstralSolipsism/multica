package engineering_test

import (
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func wikiID(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{15: n}, Valid: true} }

func TestWikiTreeReferencesAndShape(t *testing.T) {
	pages := engineering.WikiTree{
		{ID: wikiID(1), Slug: "root"},
		{ID: wikiID(3), Slug: "second", ParentID: wikiID(1), Position: 1},
		{ID: wikiID(2), Slug: "first", ParentID: wikiID(1), Position: 1, ArchivedAt: pgtype.Timestamptz{Valid: true}},
		{ID: wikiID(4), Slug: "leaf", ParentID: wikiID(2)},
		{ID: wikiID(5), Slug: "other"},
	}
	before := slices.Clone(pages)
	for _, tc := range []struct {
		ref  string
		want int
	}{
		{"root", 0}, {"first", 2}, {util.UUIDToString(wikiID(4)), 3},
		{"missing", -1}, {util.UUIDToString(wikiID(9)), -1}, {"", -1},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			if got := pages.Resolve(tc.ref); got != tc.want {
				t.Fatalf("Resolve(%q) = %d, want %d", tc.ref, got, tc.want)
			}
		})
	}
	for _, tc := range []struct {
		id            byte
		depth, height int
	}{
		{1, 1, 3}, {2, 2, 2}, {3, 2, 1}, {4, 3, 1}, {5, 1, 1}, {9, 1, 1},
	} {
		if depth, height := pages.Depth(wikiID(tc.id)), pages.SubtreeHeight(wikiID(tc.id)); depth != tc.depth || height != tc.height {
			t.Errorf("page %d: depth/height = %d/%d, want %d/%d", tc.id, depth, height, tc.depth, tc.height)
		}
	}
	for _, tc := range []struct {
		ancestor, node byte
		want           bool
	}{
		{1, 1, true}, {1, 4, true}, {2, 4, true}, {4, 1, false}, {1, 5, false}, {1, 9, false},
	} {
		if got := pages.IsDescendantOrSelf(wikiID(tc.ancestor), wikiID(tc.node)); got != tc.want {
			t.Errorf("descendant(%d, %d) = %v", tc.ancestor, tc.node, got)
		}
	}
	if got := pages.Siblings(wikiID(1)); !slices.Equal(got, []int{2, 1}) {
		t.Fatalf("siblings must retain archived slots and break position ties by UUID: %v", got)
	}
	if got := pages.Siblings(pgtype.UUID{}); !slices.Equal(got, []int{0, 4}) {
		t.Fatalf("roots = %v", got)
	}
	if !reflect.DeepEqual(pages, before) {
		t.Fatal("tree reads mutated the snapshot")
	}
}

func TestWikiTreePlacement(t *testing.T) {
	pages := engineering.WikiTree{
		{ID: wikiID(1), Slug: "a", Position: 0},
		{ID: wikiID(2), Slug: "b", Position: 1},
		{ID: wikiID(3), Slug: "c", Position: 2, ArchivedAt: pgtype.Timestamptz{Valid: true}},
		{ID: wikiID(4), Slug: "d", Position: 3},
	}
	for _, tc := range []struct {
		name     string
		index    int
		after    *string
		order    []int
		position int32
	}{
		{"create appends", 4, nil, []int{0, 1, 2, 3, 4}, 4},
		{"create first", 4, new("first"), []int{4, 0, 1, 2, 3}, 0},
		{"backward move", 3, new("a"), []int{0, 3, 1, 2}, 1},
		{"forward move", 0, new("c"), []int{1, 2, 0, 3}, 2},
		{"self appends", 1, new("b"), []int{0, 2, 3, 1}, 3},
		{"unknown appends", 1, new("missing"), []int{0, 2, 3, 1}, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			order, position := pages.InsertAfter(pgtype.UUID{}, tc.index, tc.after)
			if !slices.Equal(order, tc.order) || position != tc.position {
				t.Fatalf("placement = %v at %d, want %v at %d", order, position, tc.order, tc.position)
			}
		})
	}
	for _, tc := range []struct {
		position int32
		order    []int
		want     int32
	}{
		{0, []int{3, 0, 1, 2}, 0}, {1, []int{0, 3, 1, 2}, 1}, {99, []int{0, 1, 2, 3}, 3},
	} {
		order, position := pages.InsertAt(pgtype.UUID{}, 3, tc.position)
		if !slices.Equal(order, tc.order) || position != tc.want {
			t.Errorf("historical position %d: %v at %d", tc.position, order, position)
		}
	}
	if got := pages.SiblingsExcept(pgtype.UUID{}, 1); !slices.Equal(got, []int{0, 2, 3}) {
		t.Fatalf("origin order = %v", got)
	}
	if order, position := pages.InsertAfter(wikiID(1), 3, nil); !slices.Equal(order, []int{3}) || position != 0 {
		t.Fatalf("new parent order = %v at %d", order, position)
	}
}

func TestWikiTreeArchiveBatches(t *testing.T) {
	batch := pgtype.Timestamptz{Time: time.Unix(100, 0), Valid: true}
	older := pgtype.Timestamptz{Time: time.Unix(50, 0), Valid: true}
	for _, tc := range []struct {
		name               string
		restore, recursive bool
		want               []int
	}{
		{"archive root", false, false, []int{0}},
		{"archive subtree", false, true, []int{0, 1, 2}},
		{"restore root", true, false, []int{0}},
		{"restore matching batch", true, true, []int{0, 1, 2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pages := engineering.WikiTree{
				{ID: wikiID(1)},
				{ID: wikiID(2), ParentID: wikiID(1)},
				{ID: wikiID(3), ParentID: wikiID(2)},
				{ID: wikiID(4), ParentID: wikiID(1), ArchivedAt: older},
				{ID: wikiID(5), ParentID: wikiID(4)},
				{ID: wikiID(6)},
			}
			if tc.restore {
				for _, i := range []int{0, 1, 2, 4, 5} {
					pages[i].ArchivedAt = batch
				}
			}
			before := slices.Clone(pages)
			var got []int
			if tc.restore {
				got = pages.RestoreFlip(0, tc.recursive)
			} else {
				got = pages.ArchiveFlip(0, tc.recursive)
			}
			if !slices.Equal(got, tc.want) || !reflect.DeepEqual(pages, before) {
				t.Fatalf("flips = %v, want %v; snapshot must stay unchanged", got, tc.want)
			}
		})
	}
}

func TestWikiTreeGeneratedSlugs(t *testing.T) {
	pages := engineering.WikiTree{}
	for range 32 {
		slug := pages.GenerateSlug()
		if !engineering.ValidSlug(slug) || !strings.HasPrefix(slug, "p-") || len(slug) != 8 || pages.Resolve(slug) >= 0 {
			t.Fatalf("invalid or reserved generated slug %q", slug)
		}
		pages = append(pages, db.ProjectBaselinePage{Slug: slug, ArchivedAt: pgtype.Timestamptz{Valid: true}})
	}
}
