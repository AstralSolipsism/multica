package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/effortmod"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
	"github.com/multica-ai/multica/server/internal/daemon/ysk"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// TestEffortModInstallAndCoexistence locks the install contract: the mod and
// its context land under the task config root with 0600, a stale enablement
// marker is cleared, and the returned env coexists with labrastro-ysk's
// plugin dir instead of replacing it.
func TestEffortModInstallAndCoexistence(t *testing.T) {
	t.Parallel()
	configRoot := t.TempDir()
	// Simulate the ysk mod already installed: its plugin dir is in the list.
	yskPaths := ysk.PathsFor(configRoot)
	if err := os.MkdirAll(filepath.Join(yskPaths.Plugin, ".claude-plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A stale marker from a previous run must not survive installation.
	staleMarker := effortmod.PathsFor(configRoot).EnabledFile
	if err := os.MkdirAll(filepath.Dir(staleMarker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleMarker, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}

	vars, err := effortmod.Install(configRoot, effortmod.EffortContext{
		Version:       1,
		TaskID:        "task-1",
		Endpoint:      "/tasks/task-1/thinking-decision",
		StartupEffort: "medium",
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if vars[effortmod.ContextFileEnv] == "" {
		t.Fatalf("context env missing: %v", vars)
	}
	manifest, err := os.ReadFile(filepath.Join(effortmod.PathsFor(configRoot).Plugin, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatalf("mod manifest not installed: %v", err)
	}
	var plugin struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(manifest, &plugin); err != nil || plugin.Name != effortmod.PluginName {
		t.Fatalf("manifest: %s (%v)", manifest, err)
	}
	info, err := os.Stat(vars[effortmod.ContextFileEnv])
	if err != nil {
		t.Fatalf("context file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("context file mode: %v", info.Mode().Perm())
	}
	if _, err := os.Stat(effortmod.PathsFor(configRoot).EnabledFile); !os.IsNotExist(err) {
		t.Fatalf("stale enablement marker survived: %v", err)
	}
	// The merged plugin list keeps ysk first.
	merged := effortmod.MergePluginDir(yskPaths.Plugin, effortmod.PathsFor(configRoot).Plugin)
	if merged != fmt.Sprintf("%s%c%s", yskPaths.Plugin, os.PathListSeparator, effortmod.PathsFor(configRoot).Plugin) {
		t.Fatalf("merged plugin dirs: %q", merged)
	}

	for _, bad := range []effortmod.EffortContext{
		{Version: 2, TaskID: "t", Endpoint: "/e", StartupEffort: "low"},
		{Version: 1, Endpoint: "/e", StartupEffort: "low"},
		{Version: 1, TaskID: "t", StartupEffort: "low"},
	} {
		if _, err := effortmod.Install(configRoot, bad); err == nil {
			t.Fatalf("install accepted an incomplete context: %+v", bad)
		}
	}
}

func TestSupportsClaudePerTurnEffortVersions(t *testing.T) {
	t.Parallel()
	for version, want := range map[string]bool{
		"2.1.304":               true,
		"2.1.304 (Claude Code)": true,
		"v2.2.0":                true,
		"2.1.303":               false,
		"2.1.269":               false,
		"":                      false,
		"unknown":               false,
	} {
		if got := agent.SupportsClaudePerTurnEffort(version); got != want {
			t.Errorf("SupportsClaudePerTurnEffort(%q) = %v, want %v", version, got, want)
		}
	}
}

// TestPrepareStepEffortGates verifies the daemon-side gates: an old CLI, a
// non-adapt request, or a single candidate each keep the mod off, while a
// run-level fallback (empty startup effort, candidates present) still
// installs — the mod then starts with no level (contract §6/§7).
func TestPrepareStepEffortGates(t *testing.T) {
	t.Parallel()
	d := &Daemon{cfg: Config{CLIVersion: "v1.0.0"}, logger: slog.Default()}
	configRoot := t.TempDir()
	env := &execenv.Environment{MulticaConfigRoot: configRoot}
	task := Task{ID: "task-gate"}

	orig := listModels
	listModels = func(_ context.Context, _ string, _ agent.Command) (agent.Catalog, error) {
		return agent.Catalog{Models: []agent.Model{{
			ID:      "claude-sonnet-5-5",
			Default: true,
			Thinking: &agent.ModelThinking{SupportedLevels: []agent.ThinkingLevel{
				{Value: "low"}, {Value: "medium"}, {Value: "high"},
			}},
		}}}, nil
	}
	t.Cleanup(func() { listModels = orig })

	task = Task{ID: "task-gate", ThreadName: "修复调度器竞态", IssueDescription: "高并发下任务偶发被领取两次。"}
	// Old CLI.
	if vars := d.prepareStepEffort(task, "claude", "claude-sonnet-5-5", "2.1.269", agent.ThinkingLevelAdapt, "low",
		agent.Command{}, env, map[string]string{}, d.logger); vars != nil {
		t.Fatalf("old CLI installed the mod: %v", vars)
	}
	if _, ok := d.stepEffort.get("task-gate"); ok {
		t.Fatalf("old CLI registered a step run")
	}
	// Fixed level.
	if vars := d.prepareStepEffort(task, "claude", "claude-sonnet-5-5", "2.1.304", "high", "high",
		agent.Command{}, env, map[string]string{}, d.logger); vars != nil {
		t.Fatalf("fixed level installed the mod: %v", vars)
	}
	// Run-level fallback (empty startup effort): the mod still installs and
	// starts with no level.
	vars := d.prepareStepEffort(task, "claude", "claude-sonnet-5-5", "2.1.304", agent.ThinkingLevelAdapt, "",
		agent.Command{}, env, map[string]string{}, d.logger)
	if vars == nil {
		t.Fatal("run-level fallback kept the mod off")
	}
	if vars[effortmod.ContextFileEnv] == "" || vars[yskPluginDirsEnv] == "" {
		t.Fatalf("env incomplete: %v", vars)
	}
	run, ok := d.stepEffort.get("task-gate")
	if !ok {
		t.Fatal("no step run registered")
	}
	if len(run.Candidates) != 3 {
		t.Fatalf("candidates: %d", len(run.Candidates))
	}
	// The step state's goal must be the run's plain-text title+description
	// (contract §4), not the run-level state's JSON encoding.
	if run.Goal != "修复调度器竞态\n高并发下任务偶发被领取两次。" {
		t.Fatalf("goal is not plain-text title+description: %q", run.Goal)
	}
	// A single candidate keeps the mod off (adapt needs >= 2).
	listModels = func(_ context.Context, _ string, _ agent.Command) (agent.Catalog, error) {
		return agent.Catalog{Models: []agent.Model{{
			ID: "claude-sonnet-5-5", Thinking: &agent.ModelThinking{SupportedLevels: []agent.ThinkingLevel{{Value: "low"}}},
		}}}, nil
	}
	configRoot2 := t.TempDir()
	env2 := &execenv.Environment{MulticaConfigRoot: configRoot2}
	if vars := d.prepareStepEffort(Task{ID: "task-gate-2"}, "claude", "claude-sonnet-5-5", "2.1.304", agent.ThinkingLevelAdapt, "low",
		agent.Command{}, env2, map[string]string{}, d.logger); vars != nil {
		t.Fatalf("single candidate installed the mod: %v", vars)
	}
}
