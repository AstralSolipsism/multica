package handler

import (
	"context"
	"embed"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	skillpkg "github.com/multica-ai/multica/server/internal/skill"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// preset_skills carries workspace skills every new workspace starts with.
// Unlike builtin_skills (invisible, force-injected into every agent's bundle),
// these are ordinary `skill` rows: visible in the workspace skill list,
// editable, deletable, and bound per-agent by choice. Deletion sticks — no
// read path resurrects them.
//
//go:embed preset_skills
var presetSkillsFS embed.FS

const presetSkillsRoot = "preset_skills"

// errPresetSkillMalformed marks a shipped preset SKILL.md without a usable
// frontmatter name. The embed test catches it before a release does.
var errPresetSkillMalformed = errors.New("preset skill is malformed")

// seedPresetSkills writes one skill row per preset_skills/<name>/SKILL.md into
// a workspace, inside the caller's CreateWorkspace transaction (qtx). Name and
// description come from the frontmatter via skill.ParseSkillFrontmatter so the
// embedded file stays the single source of truth. A malformed preset fails the
// workspace creation: shipping a workspace without its advertised skills is
// worse than not shipping it.
func seedPresetSkills(ctx context.Context, qtx *db.Queries, workspaceID, creatorID pgtype.UUID) error {
	entries, err := presetSkillsFS.ReadDir(presetSkillsRoot)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		content, err := presetSkillsFS.ReadFile(presetSkillsRoot + "/" + entry.Name() + "/SKILL.md")
		if err != nil {
			return err
		}
		name, description := skillpkg.ParseSkillFrontmatter(string(content))
		if name == "" {
			// Compile-time-shipped content: a missing name is a packaging
			// bug. Failing the creation beats shipping a workspace whose
			// advertised skill silently never appears.
			return fmt.Errorf("preset skill %s: missing frontmatter name: %w", entry.Name(), errPresetSkillMalformed)
		}
		if _, err := qtx.CreateSkill(ctx, db.CreateSkillParams{
			WorkspaceID: workspaceID,
			Name:        name,
			Description: description,
			Content:     sanitizeNullBytes(string(content)),
			Config:      []byte("{}"),
			CreatedBy:   creatorID,
		}); err != nil {
			return err
		}
	}
	return nil
}
