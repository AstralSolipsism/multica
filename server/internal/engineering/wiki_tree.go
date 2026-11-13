package engineering

import (
	"cmp"
	"crypto/rand"
	"math/big"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// WikiTree is a project's page snapshot, including archived pages. Methods
// compute indices and orders without writing rows; callers persist them in the
// transaction that loaded the snapshot. Parent links must form a valid forest.
type WikiTree []db.ProjectBaselinePage

func (pages WikiTree) IndexByID(id pgtype.UUID) int {
	for i := range pages {
		if pages[i].ID == id {
			return i
		}
	}
	return -1
}

// Resolve resolves {page} as a UUID or a slug.
func (pages WikiTree) Resolve(ref string) int {
	if id, err := util.ParseUUID(ref); err == nil {
		return pages.IndexByID(id)
	}
	for i := range pages {
		if pages[i].Slug == ref {
			return i
		}
	}
	return -1
}

// Siblings returns indices under parent ordered by (position, id).
// Archived pages keep their slot (I3a).
func (pages WikiTree) Siblings(parent pgtype.UUID) []int {
	out := []int{}
	for i := range pages {
		if pages[i].ParentID == parent {
			out = append(out, i)
		}
	}
	slices.SortFunc(out, func(a, b int) int {
		if c := cmp.Compare(pages[a].Position, pages[b].Position); c != 0 {
			return c
		}
		return strings.Compare(util.UUIDToString(pages[a].ID), util.UUIDToString(pages[b].ID))
	})
	return out
}

// SiblingsExcept keeps archived slots but removes the page being repositioned.
func (pages WikiTree) SiblingsExcept(parent pgtype.UUID, index int) []int {
	return slices.DeleteFunc(pages.Siblings(parent), func(i int) bool { return i == index })
}

// InsertAfter resolves the destination after removing the moving page, so a
// backward move within one sibling set cannot overshoot. Unknown slugs append.
// index may equal len(pages) when planning a newly created page.
func (pages WikiTree) InsertAfter(parent pgtype.UUID, index int, after *string) ([]int, int32) {
	order := pages.SiblingsExcept(parent, index)
	position := len(order)
	if after != nil {
		if *after == "first" {
			position = 0
		} else {
			for pos, i := range order {
				if pages[i].Slug == *after {
					position = pos + 1
					break
				}
			}
		}
	}
	return slices.Insert(order, position, index), int32(position)
}

// InsertAt clamps a historical position to the destination sibling set.
func (pages WikiTree) InsertAt(parent pgtype.UUID, index int, position int32) ([]int, int32) {
	order := pages.SiblingsExcept(parent, index)
	position = min(position, int32(len(order)))
	return slices.Insert(order, int(position), index), position
}

func (pages WikiTree) Depth(id pgtype.UUID) int {
	depth := 1
	for {
		i := pages.IndexByID(id)
		if i < 0 || !pages[i].ParentID.Valid {
			return depth
		}
		id = pages[i].ParentID
		depth++
	}
}

func (pages WikiTree) SubtreeHeight(id pgtype.UUID) int {
	height := 1
	for i := range pages {
		if pages[i].ParentID == id {
			if h := pages.SubtreeHeight(pages[i].ID); h+1 > height {
				height = h + 1
			}
		}
	}
	return height
}

func (pages WikiTree) IsDescendantOrSelf(ancestor, node pgtype.UUID) bool {
	for {
		if node == ancestor {
			return true
		}
		i := pages.IndexByID(node)
		if i < 0 || !pages[i].ParentID.Valid {
			return false
		}
		node = pages[i].ParentID
	}
}

func (pages WikiTree) GenerateSlug() string {
	taken := map[string]bool{}
	for _, p := range pages {
		taken[p.Slug] = true
	}
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	for range 16 {
		runes := make([]byte, 6)
		for i := range runes {
			n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
			if err != nil {
				return ""
			}
			runes[i] = alphabet[n.Int64()]
		}
		slug := "p-" + string(runes)
		if !taken[slug] {
			return slug
		}
	}
	return ""
}

// ArchiveFlip selects the subtree pages whose archived flag actually
// changes: the root plus, when recursive, every unarchived descendant.
func (pages WikiTree) ArchiveFlip(root int, recursive bool) []int {
	flips := []int{root}
	if !recursive {
		return flips
	}
	var walk func(id pgtype.UUID)
	walk = func(id pgtype.UUID) {
		for i := range pages {
			if pages[i].ParentID == id && !pages[i].ArchivedAt.Valid {
				flips = append(flips, i)
				walk(pages[i].ID)
			}
		}
	}
	walk(pages[root].ID)
	return flips
}

// RestoreFlip selects the pages restored together with the root: the root
// plus, when recursive, descendants archived in the same batch.
func (pages WikiTree) RestoreFlip(root int, recursive bool) []int {
	flips := []int{root}
	if !recursive {
		return flips
	}
	batch := pages[root].ArchivedAt
	var walk func(id pgtype.UUID)
	walk = func(id pgtype.UUID) {
		for i := range pages {
			if pages[i].ParentID == id && pages[i].ArchivedAt.Valid && pages[i].ArchivedAt == batch {
				flips = append(flips, i)
				walk(pages[i].ID)
			}
		}
	}
	walk(pages[root].ID)
	return flips
}
