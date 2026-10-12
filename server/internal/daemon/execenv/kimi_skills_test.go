package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareKimiSkillsUseSharedProjectRoot(t *testing.T) {
	t.Parallel()
	task := TaskContextForEnv{
		IssueID: "kimi-project-skills",
		AgentSkills: []SkillContextForEnv{
			{Name: "multica-platform", Description: "Operate Labrastro", Content: "Use the multica CLI."},
			{Name: "humanizer", Description: "Edit prose", Content: "Rewrite inflated prose."},
		},
	}
	env, err := Prepare(PrepareParams{
		WorkspacesRoot: t.TempDir(),
		WorkspaceID:    "ws-kimi-skills",
		TaskID:         "11112222-3333-4444-5555-666677778888",
		Provider:       "kimi",
		Task:           task,
	}, testLogger())
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	defer env.Cleanup(true)

	// Assert the discovery contract independently of skillsDirPath: Kimi Code
	// scans .agents/skills at the project root, not the former .kimi/skills.
	for _, skill := range task.AgentSkills {
		path := filepath.Join(env.WorkDir, ".agents", "skills", skill.Name, "SKILL.md")
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read discoverable skill %s: %v", skill.Name, err)
		}
		for _, want := range []string{"name: " + skill.Name, "description:", skill.Description, skill.Content} {
			if !strings.Contains(string(body), want) {
				t.Errorf("skill %s missing %q: %s", skill.Name, want, body)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(env.WorkDir, ".kimi")); !os.IsNotExist(err) {
		t.Errorf("Prepare should not write the obsolete Kimi directory: %v", err)
	}
	if err := CleanupSidecars(env.RootDir); err != nil {
		t.Fatalf("CleanupSidecars: %v", err)
	}
	if _, err := os.Stat(filepath.Join(env.WorkDir, ".agents")); !os.IsNotExist(err) {
		t.Errorf("manifest cleanup should remove the managed project skill tree: %v", err)
	}
}

func TestReuseKimiMigratesManagedSkills(t *testing.T) {
	t.Parallel()
	envRoot := t.TempDir()
	workDir := filepath.Join(envRoot, "workdir")
	legacyRoot := filepath.Join(workDir, ".kimi", "skills")
	task := TaskContextForEnv{
		IssueID: "kimi-skill-migration",
		AgentSkills: []SkillContextForEnv{
			{Name: "multica-platform", Description: "Operate Labrastro", Content: "Updated platform skill."},
		},
	}

	// Seed a user-owned sibling in each layout; neither belongs to the prior
	// manifest, so migrating and refreshing managed skills must preserve them.
	for _, root := range []string{legacyRoot, filepath.Join(workDir, ".agents", "skills")} {
		userDir := filepath.Join(root, "user-skill")
		if err := os.MkdirAll(userDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(userDir, "SKILL.md"), []byte("user-owned skill"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	before := snapshot(t, workDir)

	// Model a manifest written by the old daemon, including an unbound skill
	// and unrecorded scratch left by the agent inside a managed skill dir.
	manifest := &sidecarManifest{}
	oldSkills := []SkillContextForEnv{
		{Name: "multica-platform", Content: "Old platform skill."},
		{Name: "removed-skill", Content: "No longer bound."},
	}
	if err := writeSkillFiles(legacyRoot, oldSkills, manifest); err != nil {
		t.Fatal(err)
	}
	if err := writeSidecarManifest(envRoot, manifest); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(legacyRoot, "multica-platform", "agent-notes.md")
	if err := os.WriteFile(stray, []byte("scratch"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The second reuse exercises the new manifest as well as the old one.
	for i := 0; i < 2; i++ {
		if reused := Reuse(ReuseParams{WorkDir: workDir, Provider: "kimi", Task: task}, testLogger()); reused == nil {
			t.Fatalf("Reuse #%d returned nil", i+1)
		}
		for _, skill := range oldSkills {
			if _, err := os.Stat(filepath.Join(legacyRoot, skill.Name)); !os.IsNotExist(err) {
				t.Errorf("legacy managed skill %s survived reuse: %v", skill.Name, err)
			}
		}
		body, err := os.ReadFile(filepath.Join(workDir, ".agents", "skills", "multica-platform", "SKILL.md"))
		if err != nil {
			t.Fatalf("read refreshed skill: %v", err)
		}
		if !strings.Contains(string(body), task.AgentSkills[0].Content) {
			t.Errorf("refreshed skill has stale content: %s", body)
		}
	}
	if err := CleanupSidecars(envRoot); err != nil {
		t.Fatalf("CleanupSidecars: %v", err)
	}
	assertSnapshotEqual(t, "Kimi migration preserves user skills", before, snapshot(t, workDir))
}
