package execenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestWrittenSkillDirectoriesIncludeEveryCollision(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "a-b"), 0755); err != nil {
		t.Fatal(err)
	}
	skills := []SkillContextForEnv{
		{ID: "one", Name: "A B", Content: "---\ndisable-model-invocation: true\n---\nfirst"},
		{ID: "two", Name: "A-B", Content: "second"},
	}
	installed := map[string]string{}
	if err := writeSkillFiles(root, skills, nil, installed); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"one": filepath.Join(root, "a-b-multica"), "two": filepath.Join(root, "a-b-multica-multica")}
	if !reflect.DeepEqual(installed, want) {
		t.Fatalf("installed=%v want=%v", installed, want)
	}
	for id, dir := range installed {
		body, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		if err != nil || !strings.Contains(string(body), "name: "+filepath.Base(dir)) {
			t.Fatalf("%s: %s, %v", id, body, err)
		}
	}
}

func TestPrepareAndReuseReturnSkillDirectories(t *testing.T) {
	task := TaskContextForEnv{ChatSessionID: "chat", AgentSkills: []SkillContextForEnv{{ID: "selected", Name: "Review Code", Content: "Use references/file.txt"}}}
	root := t.TempDir()
	env, err := Prepare(PrepareParams{WorkspacesRoot: root, WorkspaceID: "workspace", TaskID: "task-skill-directories", Provider: "kimi", Task: task}, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(env.WorkDir, ".agents", "skills", "review-code")
	if env.SkillDirectories["selected"] != want {
		t.Fatalf("Prepare directories=%v", env.SkillDirectories)
	}
	// The isolated preparer returns JSON, not the in-process slice/map.
	encoded, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Environment
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SkillDirectories["selected"] != want {
		t.Fatal("helper response lost directory")
	}
	reused := Reuse(ReuseParams{WorkspacesRoot: root, WorkDir: env.WorkDir, Provider: "kimi", Task: task}, testLogger())
	if reused == nil || reused.SkillDirectories["selected"] != want {
		t.Fatalf("Reuse directories=%+v", reused)
	}
}

func TestSkillBodyStripsOnlyFrontmatter(t *testing.T) {
	for _, input := range []string{"---\nname: x\n---\nbody\n---\ntail", "---\r\nname: x\r\n---\r\nbody\n---\ntail", "body\n---\ntail"} {
		if got := SkillBody(input); strings.TrimSpace(got) != "body\n---\ntail" {
			t.Fatalf("SkillBody(%q)=%q", input, got)
		}
	}
}
