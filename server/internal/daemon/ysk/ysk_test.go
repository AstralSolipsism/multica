package ysk

import (
	"encoding/json"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

const sampleContext = `{"version":1,"issue_identifier":"OL-123","anchor_comment_id":null,"latest_human_comment":"请把登录改成短信验证码","existing_tips":[],"known_topics":[],"light_tip_count":3,"check_every_steps":6,"limits":{"line":40,"title":12,"explanation":200}}`

func listFiles(t *testing.T, root string) []string {
	t.Helper()
	var files []string
	err := filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	return files
}

func TestInstallWritesTheModAndTheContextAsReceived(t *testing.T) {
	configRoot := t.TempDir()
	vars, err := Install(configRoot, json.RawMessage(sampleContext), "")
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	paths := PathsFor(configRoot)
	if paths.Plugin != filepath.Join(configRoot, "ysk", "plugin") || paths.Context != filepath.Join(configRoot, "ysk", "context.json") {
		t.Fatalf("unexpected paths %+v", paths)
	}

	want := []string{".claude-plugin/plugin.json", "hooks/context.ts", "hooks/hooks.json", "hooks/prompts.ts", "hooks/register.ts", "hooks/reply.ts"}
	if got := listFiles(t, paths.Plugin); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("mod files = %v, want %v", got, want)
	}
	written, err := os.ReadFile(paths.Context)
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != sampleContext {
		t.Fatalf("context.json = %s, want the claim field byte for byte", written)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(paths.Context); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("context.json mode = %v (%v), want 0600", info.Mode().Perm(), err)
		}
	}
	if vars[PluginDirsEnv] != paths.Plugin || vars[ContextFileEnv] != paths.Context || len(vars) != 2 {
		t.Fatalf("env = %v", vars)
	}
}

func TestInstallKeepsExistingPluginFoldersFirst(t *testing.T) {
	sep := string(os.PathListSeparator)
	for existing, wantPrefix := range map[string]string{
		"":                              "",
		sep:                             "",
		"/opt/user-plugin":              "/opt/user-plugin" + sep,
		"/opt/a" + sep + "/opt/b" + sep: "/opt/a" + sep + "/opt/b" + sep,
	} {
		configRoot := t.TempDir()
		vars, err := Install(configRoot, json.RawMessage(sampleContext), existing)
		if err != nil {
			t.Fatalf("Install: %v", err)
		}
		if want := wantPrefix + PathsFor(configRoot).Plugin; vars[PluginDirsEnv] != want {
			t.Errorf("existing %q: %s = %q, want %q", existing, PluginDirsEnv, vars[PluginDirsEnv], want)
		}
	}
}

func TestInstallReplacesAnEarlierCopy(t *testing.T) {
	configRoot := t.TempDir()
	paths := PathsFor(configRoot)
	stale := filepath.Join(paths.Plugin, "hooks", "retired.ts")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("export {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(configRoot, json.RawMessage(sampleContext), ""); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale mod file survived reinstall: %v", err)
	}
}

func TestInstallRefusesAContextThatIsNotAnObject(t *testing.T) {
	for _, context := range []string{``, `null`, `[]`, `"text"`, `{"version":1`} {
		configRoot := t.TempDir()
		if _, err := Install(configRoot, json.RawMessage(context), ""); err == nil {
			t.Errorf("Install accepted context %q", context)
		}
		if entries, _ := os.ReadDir(configRoot); len(entries) != 0 {
			t.Errorf("context %q: Install wrote %d entries before refusing", context, len(entries))
		}
	}
	if _, err := Install("", json.RawMessage(sampleContext), ""); err == nil {
		t.Error("Install accepted an empty config directory")
	}
}

func TestInstallRefusesAnUnremovableStopMarker(t *testing.T) {
	configRoot := t.TempDir()
	// A nonempty directory deterministically makes Remove fail, including
	// when the tests run as root and permission bits would not block it.
	stop := PathsFor(configRoot).Stop
	if err := os.MkdirAll(stop, 0o755); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(stop, "keep")
	if err := os.WriteFile(child, []byte("old marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	vars, err := Install(configRoot, json.RawMessage(sampleContext), "")
	if err == nil || !strings.Contains(err.Error(), "clear you_should_know stop marker") {
		t.Fatalf("expected stop marker cleanup error, got %v", err)
	}
	if vars != nil {
		t.Fatalf("failed installation exposed mod environment: %v", vars)
	}
	if data, err := os.ReadFile(child); err != nil || string(data) != "old marker" {
		t.Fatalf("failed cleanup changed the old marker: %q (%v)", data, err)
	}
}

// The stream hook recognises the mod by the name in its manifest.
func TestEmbeddedManifestNamesTheModTheStreamHookExpects(t *testing.T) {
	data, err := modFS.ReadFile(path.Join(modRoot, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Name != agent.ClaudeYouShouldKnowPlugin {
		t.Fatalf("manifest name %q, stream hook expects %q", manifest.Name, agent.ClaudeYouShouldKnowPlugin)
	}
}

// Every module the hooks load must be in the embed list, or the installed
// copy would fail to load while the source tree still passes its own tests.
func TestEmbeddedModulesResolve(t *testing.T) {
	var hooks struct {
		Modules []string `json:"modules"`
	}
	data, err := modFS.ReadFile(path.Join(modRoot, "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &hooks); err != nil {
		t.Fatal(err)
	}
	importRe := regexp.MustCompile(`(?m)^import[^'"]*from\s+['"](\.[^'"]+)['"]`)
	pending := append([]string(nil), hooks.Modules...)
	seen := map[string]bool{}
	for len(pending) > 0 {
		module := pending[0]
		pending = pending[1:]
		name := path.Join(modRoot, "hooks", module)
		if path.Ext(name) == "" {
			name += ".ts"
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		source, err := modFS.ReadFile(name)
		if err != nil {
			t.Fatalf("module %s is not embedded: %v", name, err)
		}
		for _, match := range importRe.FindAllStringSubmatch(string(source), -1) {
			pending = append(pending, path.Join(path.Dir(strings.TrimPrefix(name, modRoot+"/hooks/")), match[1]))
		}
	}
	if !seen[path.Join(modRoot, "hooks", "register.ts")] || len(seen) < 4 {
		t.Fatalf("resolved modules %v", seen)
	}
}
