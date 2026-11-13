package engineering

import (
	"slices"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// WikiRevisionConflict applies the optimistic-lock rules to the (base, current]
// revision window. Section writes additionally require byte-identical subtrees;
// malformed or missing sections retain their normal content errors.
func WikiRevisionConflict(kind string, base, current db.ProjectBaselineRevision, window []db.ProjectBaselineRevision, section string) (bool, error) {
	if base.RevisionNumber == current.RevisionNumber {
		return false, nil
	}
	switch kind {
	case "content", "rename":
		return wikiWindowHasKinds(window, kind, "archive", "restore", "rollback"), nil
	case "move":
		return wikiWindowHasKinds(window, "move", "archive", "restore", "rollback") || base.ParentID != current.ParentID, nil
	case "section":
		if wikiWindowHasKinds(window, "archive", "restore", "rollback") {
			return true, nil
		}
		before, err := SectionSubtree(base.ContentMarkdown, section)
		if err != nil {
			return false, err
		}
		after, err := SectionSubtree(current.ContentMarkdown, section)
		if err != nil {
			return false, err
		}
		return before != after, nil
	default:
		// Archive, restore and rollback require the exact current revision.
		return true, nil
	}
}

func wikiWindowHasKinds(window []db.ProjectBaselineRevision, kinds ...string) bool {
	for _, revision := range window {
		if slices.Contains(kinds, revision.RevisionKind) {
			return true
		}
	}
	return false
}

type WikiStructureChange struct {
	From any `json:"from"`
	To   any `json:"to"`
}

// WikiStructureDiff compares revision snapshots, resolving parents against the
// current tree and retaining UUIDs for parents that no longer exist.
func WikiStructureDiff(pages []db.ProjectBaselinePage, old, next db.ProjectBaselineRevision) map[string]WikiStructureChange {
	slugOf := func(id pgtype.UUID) string {
		if !id.Valid {
			return ""
		}
		if j := WikiTree(pages).IndexByID(id); j >= 0 {
			return pages[j].Slug
		}
		return util.UUIDToString(id)
	}
	structure := map[string]WikiStructureChange{}
	if old.Title != next.Title {
		structure["title"] = WikiStructureChange{old.Title, next.Title}
	}
	if old.Slug != next.Slug {
		structure["slug"] = WikiStructureChange{old.Slug, next.Slug}
	}
	if old.ParentID != next.ParentID {
		structure["parent"] = WikiStructureChange{slugOf(old.ParentID), slugOf(next.ParentID)}
	}
	if old.Position != next.Position {
		structure["position"] = WikiStructureChange{old.Position, next.Position}
	}
	if old.ArchivedAt.Valid != next.ArchivedAt.Valid {
		structure["archived"] = WikiStructureChange{old.ArchivedAt.Valid, next.ArchivedAt.Valid}
	}
	return structure
}
