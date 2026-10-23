package effortmod

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInstallWritesModContextAndClearsMarker(t *testing.T) {
	t.Parallel()
	configRoot := t.TempDir()
	paths := PathsFor(configRoot)
	if err := os.MkdirAll(filepath.Dir(paths.EnabledFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.EnabledFile, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	vars, err := Install(configRoot, EffortContext{Version: 1, TaskID: "task-9", Endpoint: "/tasks/task-9/thinking-decision", StartupEffort: "low"})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if vars[ContextFileEnv] != paths.Context {
		t.Fatalf("context env: %v", vars)
	}
	raw, err := os.ReadFile(paths.Context)
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	var context EffortContext
	if err := json.Unmarshal(raw, &context); err != nil || context.TaskID != "task-9" || context.StartupEffort != "low" {
		t.Fatalf("context body: %s (%v)", raw, err)
	}
	if info, err := os.Stat(paths.Context); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("context mode: %v (%v)", info, err)
	}
	if _, err := os.Stat(paths.EnabledFile); !os.IsNotExist(err) {
		t.Fatalf("stale marker survived: %v", err)
	}
	// The embedded mod is complete: manifest, hooks.json and the module.
	for _, name := range []string{
		filepath.Join(".claude-plugin", "plugin.json"),
		filepath.Join("hooks", "hooks.json"),
		filepath.Join("hooks", "register.ts"),
	} {
		if _, err := os.Stat(filepath.Join(paths.Plugin, name)); err != nil {
			t.Fatalf("mod file %s missing: %v", name, err)
		}
	}
	manifest, err := os.ReadFile(filepath.Join(paths.Plugin, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var plugin struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(manifest, &plugin); err != nil || plugin.Name != PluginName {
		t.Fatalf("manifest: %s (%v)", manifest, err)
	}
}

func TestInstallRejectsIncompleteContext(t *testing.T) {
	t.Parallel()
	configRoot := t.TempDir()
	for _, context := range []EffortContext{
		{Version: 0, TaskID: "t", Endpoint: "/e", StartupEffort: "low"},
		{Version: 1, Endpoint: "/e", StartupEffort: "low"},
		{Version: 1, TaskID: "t", StartupEffort: "low"},
	} {
		if _, err := Install(configRoot, context); err == nil {
			t.Fatalf("install accepted %+v", context)
		}
	}
	if _, err := Install("", EffortContext{Version: 1, TaskID: "t", Endpoint: "/e", StartupEffort: "low"}); err == nil {
		t.Fatal("install accepted an empty config root")
	}
}

func TestMergePluginDirKeepsExistingFirst(t *testing.T) {
	t.Parallel()
	sep := string(os.PathListSeparator)
	if got := MergePluginDir("", "/a"); got != "/a" {
		t.Fatalf("empty list: %q", got)
	}
	if got := MergePluginDir("/ysk"+sep, "/effort"); got != "/ysk"+sep+"/effort" {
		t.Fatalf("merged: %q", got)
	}
}
