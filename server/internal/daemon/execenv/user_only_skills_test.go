package execenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestUserOnlySkillRuntimePolicies(t *testing.T) {
	for _, tc := range []struct {
		name, content, policy string
		claude, codex         bool
	}{
		{"ordinary", "body", "", false, false},
		{"Claude only", "---\ndisable-model-invocation: true\n---\nbody", "", true, false},
		{"Codex only", "body", "policy:\n  allow_implicit_invocation: false\n", false, true},
		{"Codex opt in", "body", "policy:\n  allow_implicit_invocation: true\n", false, false},
		{"no Codex flag", "body", "interface:\n  display_name: private\n", false, false},
		{"invalid Codex policy", "body", "policy: [", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			skill := SkillContextForEnv{Content: tc.content, Files: []SkillFileContextForEnv{{Path: "./agents/openai.yaml", Content: tc.policy}}}
			for provider, want := range map[string]bool{"claude": tc.claude, "codex": tc.codex, "antigravity": false, "kimi": false, "hermes": false} {
				if got := runtimeUserOnlySkill(provider, skill); got != want {
					t.Errorf("%s=%v want %v", provider, got, want)
				}
			}
		})
	}
}

func TestUserOnlySkillsPrepareReuseAndStableBrief(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			task := TaskContextForEnv{TaskID: "first", IssueID: "issue", AgentSkills: []SkillContextForEnv{
				{ID: "private", Name: "A B", Content: "---\ndisable-model-invocation: true\n---\nPRIVATE_BODY", Files: []SkillFileContextForEnv{{Path: "agents/openai.yaml", Content: "policy:\n  allow_implicit_invocation: false\n"}}},
				{ID: "public", Name: "A-B", Content: "PUBLIC_BODY"},
			}}
			root := t.TempDir()
			env, err := Prepare(PrepareParams{WorkspacesRoot: root, WorkspaceID: "ws", TaskID: "task", Provider: provider, Task: task}, testLogger())
			if err != nil {
				t.Fatal(err)
			}
			originalBrief := buildMetaSkillContent(provider, task)
			public := env.SkillDirectories["public"]
			if filepath.Base(public) != "a-b-multica" {
				t.Fatal(env.SkillDirectories)
			}
			private := filepath.Join(filepath.Dir(public), "a-b")
			var settings []byte
			if provider == "claude" {
				settings, err = os.ReadFile(env.ClaudeSettingsPath)
				if err != nil {
					t.Fatal(err)
				}
			}
			for _, selected := range []bool{false, true, false} {
				task.AgentSkills[0].ExplicitlySelected = selected
				env = Reuse(ReuseParams{WorkspacesRoot: root, WorkDir: env.WorkDir, Provider: provider, Task: task}, testLogger())
				if env == nil {
					t.Fatal("reuse failed")
				}
				_, err := os.Stat(private)
				if selected && err != nil || !selected && !os.IsNotExist(err) {
					t.Fatalf("selected=%v private stat=%v", selected, err)
				}
				if got := env.SkillDirectories["private"] != ""; got != selected {
					t.Fatal(env.SkillDirectories)
				}
				if env.SkillDirectories["public"] != public {
					t.Fatal("slug changed on selection")
				}
				if got := buildMetaSkillContent(provider, task); got != originalBrief {
					t.Fatal("brief changed with per-turn selection")
				}
				if provider == "claude" {
					got, err := os.ReadFile(env.ClaudeSettingsPath)
					if err != nil || string(got) != string(settings) {
						t.Fatal("deny settings changed on selection")
					}
				}
				if selected { // Reuse must remove even files created by the last run.
					if err := os.WriteFile(filepath.Join(private, "scratch"), []byte("old"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
		})
	}
}

func TestRunNotesSidecarRoundTripAndCleanup(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "workdir")
	if err := os.MkdirAll(work, 0755); err != nil {
		t.Fatal(err)
	}
	ctx := TaskContextForEnv{TaskID: "one", RunNotes: RunNotesForEnv{Handoff: "exact /private $private\ncheckin command", JoinedWakeups: "joined /batch"}}
	manifest := &sidecarManifest{}
	if err := writeContextFiles(work, "claude", ctx, manifest, nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(work, RunNotesRelPath(ctx.TaskID)))
	if err != nil {
		t.Fatal(err)
	}
	var got RunNotesForEnv
	if err := json.Unmarshal(data, &got); err != nil || !reflect.DeepEqual(got, ctx.RunNotes) {
		t.Fatalf("%+v %v", got, err)
	}
	if strings.Contains(buildMetaSkillContent("claude", ctx), "checkin command") {
		t.Fatal("notes entered stable brief")
	}
	if RunNotesRelPath("one") == RunNotesRelPath("two") {
		t.Fatal("concurrent task notes collide")
	}
	if err := rollBackPreparedSidecars(*manifest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(work, RunNotesRelPath(ctx.TaskID))); !os.IsNotExist(err) {
		t.Fatalf("notes survived cleanup: %v", err)
	}
}
