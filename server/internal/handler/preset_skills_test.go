package handler

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	skillpkg "github.com/multica-ai/multica/server/internal/skill"
)

// TestPresetSkillsFrontmatterParses guards the embedded preset SKILL.md files
// at the packaging seam: each must carry a frontmatter name (and description),
// because seedPresetSkills refuses to create a workspace rather than ship a
// preset that silently never appears (OL-1207).
func TestPresetSkillsFrontmatterParses(t *testing.T) {
	entries, err := fs.ReadDir(presetSkillsFS, presetSkillsRoot)
	if err != nil {
		t.Fatalf("read preset_skills embed: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("preset_skills embed is empty")
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		content, err := fs.ReadFile(presetSkillsFS, presetSkillsRoot+"/"+entry.Name()+"/SKILL.md")
		if err != nil {
			t.Fatalf("preset %s: read SKILL.md: %v", entry.Name(), err)
		}
		name, description := skillpkg.ParseSkillFrontmatter(string(content))
		if name == "" || description == "" {
			t.Fatalf("preset %s: frontmatter missing name or description", entry.Name())
		}
	}
}

// TestCreateWorkspaceSeedsPresetSkills covers OL-1207's acceptance: a newly
// created workspace lists image-studio in ListSkills without any manual
// import, created_by is the workspace creator, and deleting it sticks —
// listing again shows no resurrection.
func TestCreateWorkspaceSeedsPresetSkills(t *testing.T) {
	const slug = "handler-create-ws-preset-skills"
	ctx := context.Background()

	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM workspace WHERE slug = $1`, slug)
	})

	req := newRequest(http.MethodPost, "/api/workspaces", map[string]string{
		"name": "Handler Create Workspace Preset Skills",
		"slug": slug,
	})
	var created WorkspaceResponse
	testutil.Call(t, testHandler.CreateWorkspace, req).Want(http.StatusCreated).JSON(&created)

	// List the new workspace's skills. newRequest stamps the default test
	// workspace into X-Workspace-ID, which outranks any query param, so
	// point it at the freshly created workspace explicitly.
	wsReq := func(method, path string) *http.Request {
		req := newRequest(method, path, nil)
		req.Header.Set("X-Workspace-ID", created.ID)
		return req
	}
	w := testutil.Call(t, testHandler.ListSkills, wsReq(http.MethodGet, "/api/skills")).Want(http.StatusOK)

	var rows []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatalf("ListSkills: decode: %v", err)
	}
	var seeded map[string]any
	for _, row := range rows {
		if row["name"] == "image-studio" {
			seeded = row
			break
		}
	}
	if seeded == nil {
		t.Fatalf("ListSkills: image-studio not seeded into new workspace %s: %v", created.ID, rows)
	}
	if got, _ := seeded["created_by"].(string); got != testUserID {
		t.Fatalf("image-studio created_by: expected creator %s, got %v", testUserID, seeded["created_by"])
	}

	// Deleting the preset must stick: it is an ordinary skill row, and no
	// read path may resurrect it.
	skillID, _ := seeded["id"].(string)
	delReq := withURLParam(wsReq(http.MethodDelete, "/api/skills/"+skillID), "id", skillID)
	testutil.Call(t, testHandler.DeleteSkill, delReq).Want(http.StatusNoContent)

	w = testutil.Call(t, testHandler.ListSkills, wsReq(http.MethodGet, "/api/skills")).Want(http.StatusOK)
	rows = nil
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatalf("ListSkills after delete: decode: %v", err)
	}
	for _, row := range rows {
		if row["name"] == "image-studio" {
			t.Fatal("ListSkills: deleted image-studio resurrected")
		}
	}
}
