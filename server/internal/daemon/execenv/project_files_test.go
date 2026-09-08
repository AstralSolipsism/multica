package execenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectFilesDiscoveryInIssueAndChatRuntime(t *testing.T) {
	t.Parallel()
	for _, provider := range []string{"claude", "codex"} {
		for _, surface := range []string{"issue", "chat"} {
			t.Run(provider+"/"+surface, func(t *testing.T) {
				t.Parallel()
				ctx := TaskContextForEnv{ProjectID: "11111111-1111-4111-8111-111111111111", ProjectTitle: "Shared file test"}
				if surface == "issue" {
					ctx.IssueID = "22222222-2222-4222-8222-222222222222"
				}
				env, err := Prepare(PrepareParams{WorkspacesRoot: t.TempDir(), WorkspaceID: "ws-test", TaskID: "33333333-3333-4333-8333-333333333333", AgentName: "File test", Provider: provider, Task: ctx}, testLogger())
				if err != nil {
					t.Fatal(err)
				}
				defer env.Cleanup(true)
				// Local sample contents must not be imported by preparation/briefing.
				const sentinel = "FULL_SHARED_DOCUMENT_MUST_STAY_ON_DEMAND"
				if err := os.WriteFile(filepath.Join(env.WorkDir, "sample.md"), []byte(sentinel), 0600); err != nil {
					t.Fatal(err)
				}
				if _, err := InjectRuntimeConfig(env.WorkDir, provider, ctx); err != nil {
					t.Fatal(err)
				}
				name := "CLAUDE.md"
				if provider == "codex" {
					name = "AGENTS.md"
				}
				brief, err := os.ReadFile(filepath.Join(env.WorkDir, name))
				if err != nil {
					t.Fatal(err)
				}
				for _, want := range []string{"multica project file capabilities " + ctx.ProjectID, "multica project file list " + ctx.ProjectID, "--base-revision", "--request-file", "retry <request-file>", "exit 6", "exit 7"} {
					if !strings.Contains(string(brief), want) {
						t.Errorf("missing %q", want)
					}
				}
				if strings.Contains(string(brief), sentinel) {
					t.Fatal("file body preloaded")
				}
				raw, err := os.ReadFile(filepath.Join(env.WorkDir, ".multica/project/resources.json"))
				if err != nil {
					t.Fatal(err)
				}
				var resource projectResourceFile
				if err := json.Unmarshal(raw, &resource); err != nil {
					t.Fatal(err)
				}
				if resource.SharedFiles == nil || resource.SharedFiles.ListCommand != "multica project file list "+ctx.ProjectID+" --output json" || len(resource.Resources) != 0 {
					t.Fatalf("missing/thick discovery: %+v", resource)
				}
				if strings.Contains(string(raw), sentinel) {
					t.Fatal("file body in discovery JSON")
				}
			})
		}
	}
}

func TestProjectFilesDiscoveryRequiresProject(t *testing.T) {
	t.Parallel()
	var brief strings.Builder
	writeProjectContext(&brief, TaskContextForEnv{})
	if strings.Contains(brief.String(), "project file") || sharedProjectFileEntry("") != nil {
		t.Fatal("no-project runtime advertised a project scope")
	}
}
