// Package ysk installs the labrastro-ysk Claude Code mod for one task: the
// "You should know" tips of OL-187. The mod's TypeScript sources live in mod/
// and ship inside the daemon binary.
package ysk

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// The mod as Claude Code loads it: the manifest, hooks.json and the hooks
// modules. Its tests stay in the source tree.
//
//go:embed mod/.claude-plugin/plugin.json mod/hooks/hooks.json mod/hooks/*.ts
var modFS embed.FS

const (
	// ContextFileEnv tells the mod where the run context is.
	ContextFileEnv = "MULTICA_YSK_CONTEXT_FILE"
	// PluginDirsEnv is Claude Code's list of plugin folders to load from disk.
	PluginDirsEnv = "CLAUDE_CODE_PLUGIN_DIRS"

	modRoot = "mod"
)

// Paths holds the mod, context and stop marker under a task's config directory.
type Paths struct {
	Plugin  string
	Context string
	Stop    string
}

// PathsFor returns the mod's folder, context and stop marker for a task config
// directory (the task's MULTICA_TASK_CONFIG_ROOT).
func PathsFor(configRoot string) Paths {
	root := filepath.Join(configRoot, "ysk")
	return Paths{Plugin: filepath.Join(root, "plugin"), Context: filepath.Join(root, "context.json"), Stop: filepath.Join(root, "stop")}
}

// Install writes the mod and the claim's `you_should_know` context, as
// received, under configRoot, and returns the environment that points Claude
// Code at them. existingPluginDirs is the CLAUDE_CODE_PLUGIN_DIRS the child
// would otherwise run with; its folders stay ahead of the mod's.
func Install(configRoot string, context json.RawMessage, existingPluginDirs string) (map[string]string, error) {
	if configRoot == "" {
		return nil, errors.New("no task config directory")
	}
	if !json.Valid(context) || !strings.HasPrefix(strings.TrimSpace(string(context)), "{") {
		return nil, errors.New("you_should_know is not a JSON object")
	}
	paths := PathsFor(configRoot)
	if err := writeMod(paths.Plugin); err != nil {
		return nil, err
	}
	if err := os.WriteFile(paths.Context, context, 0o600); err != nil {
		return nil, fmt.Errorf("write you_should_know context: %w", err)
	}
	// Later runs can reuse the same environment. Only installation starts a
	// new lifetime; toggling the workspace back on during a run never clears
	// its marker. The poller registers its path after this reset, so an off
	// signal already received for the new run will be written again.
	if err := os.Remove(paths.Stop); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("clear you_should_know stop marker: %w", err)
	}
	return map[string]string{
		PluginDirsEnv:  appendPathList(existingPluginDirs, paths.Plugin),
		ContextFileEnv: paths.Context,
	}, nil
}

// writeMod replaces dir with the embedded mod, so a reused task directory
// never keeps files from another daemon version's copy.
func writeMod(dir string) error {
	return WriteEmbeddedMod(modFS, modRoot, dir)
}

// WriteEmbeddedMod replaces dir with the files of an embedded mod (manifest,
// hooks and modules) rooted at modRoot in modFS. Shared with the other
// per-task Claude mods (labrastro-effort) so every mod installs the same way.
func WriteEmbeddedMod(modFS embed.FS, modRoot, dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("clear %s folder: %w", modRoot, err)
	}
	return fs.WalkDir(modFS, modRoot, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(name, modRoot), "/")
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := modFS.ReadFile(name)
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return fmt.Errorf("write labrastro-ysk %s: %w", path.Base(name), err)
		}
		return nil
	})
}

func appendPathList(list, dir string) string {
	if strings.Trim(list, string(os.PathListSeparator)) == "" {
		return dir
	}
	return strings.TrimRight(list, string(os.PathListSeparator)) + string(os.PathListSeparator) + dir
}
