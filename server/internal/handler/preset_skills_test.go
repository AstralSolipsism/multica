package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/skill"
	"github.com/multica-ai/multica/server/internal/testutil"
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
		name, description := skill.ParseSkillFrontmatter(string(content))
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
	skillID, _ := seeded["id"].(string)

	// The preset is an ordinary skill row: editing it through UpdateSkill
	// works like any user skill.
	w = testutil.Call(t, testHandler.UpdateSkill, updateSkillRequest(t, created.ID, skillID, "image-studio edited body")).Want(http.StatusOK)
	var updated map[string]any
	w.JSON(&updated)
	if got, _ := updated["content"].(string); got != "image-studio edited body" {
		t.Fatalf("UpdateSkill: expected edited content, got %q", got)
	}

	// Binding: an agent in the new workspace can bind the preset skill, and
	// only the bound agent receives it — an unbound agent's execution skill
	// list must not contain image-studio.
	boundAgentID := insertPresetSkillTestAgent(t, created.ID, "preset-bound")
	unboundAgentID := insertPresetSkillTestAgent(t, created.ID, "preset-unbound")

	addReq := newRequest(http.MethodPost, "/api/agents/"+boundAgentID+"/skills/add", map[string]any{"skill_ids": []string{skillID}})
	addReq.Header.Set("X-Workspace-ID", created.ID)
	addReq = withURLParam(addReq, "id", boundAgentID)
	testutil.Call(t, testHandler.AddAgentSkills, addReq).Want(http.StatusOK)

	for _, tc := range []struct{ agentID, want string }{
		{boundAgentID, "image-studio"},
		{unboundAgentID, ""},
	} {
		skills, err := testHandler.Queries.ListAgentSkills(ctx, parseUUID(tc.agentID))
		if err != nil {
			t.Fatalf("ListAgentSkills(%s): %v", tc.agentID, err)
		}
		var names []string
		found := false
		for _, s := range skills {
			names = append(names, s.Name)
			if s.Name == "image-studio" {
				found = true
			}
		}
		if tc.want == "image-studio" && !found {
			t.Fatalf("bound agent: image-studio missing from execution skills: %v", names)
		}
		if tc.want == "" && found {
			t.Fatalf("unbound agent: image-studio must not be injected into execution skills: %v", names)
		}
	}

	// Deleting the preset must stick: it is an ordinary skill row, and no
	// read path may resurrect it.
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

// updateSkillRequest builds a PUT /api/skills/{id} request carrying an
// UpdateSkillRequest body, pointed at the given workspace.
func updateSkillRequest(t *testing.T, workspaceID, skillID, content string) *http.Request {
	t.Helper()
	req := newRequest(http.MethodPut, "/api/skills/"+skillID, UpdateSkillRequest{
		Content: &content,
	})
	req.Header.Set("X-Workspace-ID", workspaceID)
	return withURLParam(req, "id", skillID)
}

// insertPresetSkillTestAgent creates a minimal agent in the given workspace,
// owned by the test user, so canManageAgent admits the binding call.
func insertPresetSkillTestAgent(t *testing.T, workspaceID, name string) string {
	t.Helper()
	var agentID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent (
			workspace_id, name, runtime_mode, visibility, permission_mode, owner_id
		)
		VALUES ($1, $2, 'local', 'workspace', 'public_to', $3)
		RETURNING id
	`, workspaceID, fmt.Sprintf("%s %d", name, time.Now().UnixNano()), testUserID).Scan(&agentID); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID)
	})
	return agentID
}
