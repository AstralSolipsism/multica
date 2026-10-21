// Package effortmod installs the labrastro-effort Claude Code mod for one
// task: per-step adaptive effort (OL-992 S3-1). The daemon decides the effort
// for each main-thread step; the mod asks the daemon's local endpoint, rewrites
// turn.step's effort, and reports the level that took effect. The mod's
// TypeScript sources live in mod/ and ship inside the daemon binary.
package effortmod

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/daemon/ysk"
)

// The mod as Claude Code loads it: manifest, hooks.json and the hooks module.
// Its tests stay in the source tree.
//
//go:embed mod/.claude-plugin/plugin.json mod/hooks/hooks.json mod/hooks/*.ts
var modFS embed.FS

const (
	// ContextFileEnv tells the mod where its run context is.
	ContextFileEnv = "MULTICA_EFFORT_CONTEXT_FILE"
	// PluginName is the mod's manifest name. Claude Code stamps it on every
	// ui_log line the mod writes; the daemon filters on it.
	PluginName = "labrastro-effort"

	modRoot = "mod"
)

// EffortContext is the JSON the daemon writes to the context file (version 1).
type EffortContext struct {
	Version int    `json:"version"`
	TaskID  string `json:"task_id"`
	// Endpoint is the absolute POST path of the daemon's decision endpoint.
	Endpoint string `json:"endpoint"`
	// StartupEffort is the effort this run started with; the mod's initial
	// "last effective level".
	StartupEffort string `json:"startup_effort"`
}

// PathsFor returns the mod's folders under a task config directory (the
// task's MULTICA_TASK_CONFIG_ROOT). EnabledFile is the enablement marker the
// daemon writes after system/init reports per_turn_effort_active and removes
// on per_turn_effort_changed=false.
func PathsFor(configRoot string) Paths {
	root := filepath.Join(configRoot, "effort")
	return Paths{
		Plugin:      filepath.Join(root, "plugin"),
		Context:     filepath.Join(root, "context.json"),
		EnabledFile: filepath.Join(root, "enabled"),
	}
}

// Paths holds the mod's folder, its context file and the enablement marker.
type Paths struct {
	Plugin      string
	Context     string
	EnabledFile string
}

// Install writes the mod and its context under configRoot, and returns the
// environment that loads it. existingPluginDirs is the CLAUDE_CODE_PLUGIN_DIRS
// the child would otherwise run with; its folders stay ahead of the mod's, so
// labrastro-ysk and labrastro-effort coexist (contract §0.9).
func Install(configRoot string, context EffortContext) (map[string]string, error) {
	if configRoot == "" {
		return nil, errors.New("no task config directory")
	}
	if context.Version != 1 || context.TaskID == "" || context.Endpoint == "" {
		return nil, fmt.Errorf("effort context is incomplete: %+v", context)
	}
	paths := PathsFor(configRoot)
	if err := ysk.WriteEmbeddedMod(modFS, modRoot, paths.Plugin); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(context)
	if err != nil {
		return nil, fmt.Errorf("marshal effort context: %w", err)
	}
	if err := os.WriteFile(paths.Context, raw, 0o600); err != nil {
		return nil, fmt.Errorf("write effort context: %w", err)
	}
	// A reused task directory must not carry an enablement marker from an
	// earlier run: the daemon writes it again only after this run's init.
	if err := os.Remove(paths.EnabledFile); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("clear effort enablement marker: %w", err)
	}
	return map[string]string{ContextFileEnv: paths.Context}, nil
}

// appendPluginDir adds dir to a CLAUDE_CODE_PLUGIN_DIRS list, keeping existing
// entries ahead. Mirrors ysk.appendPathList; kept local so the two mods' env
// handling stays independently readable.
func appendPluginDir(list, dir string) string {
	sep := string(os.PathListSeparator)
	if strings.TrimSpace(strings.ReplaceAll(list, sep, "")) == "" {
		return dir
	}
	return strings.TrimRight(list, sep) + sep + dir
}

// MergePluginDir extends the CLAUDE_CODE_PLUGIN_DIRS value this mod installs
// with. Exported for the daemon, which layers both mods' variables.
func MergePluginDir(list, dir string) string { return appendPluginDir(list, dir) }
