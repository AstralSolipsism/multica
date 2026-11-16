package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestZcodeDesktopProviderRepositoryIsPrivateAndDoesNotModifyUserConfig(t *testing.T) {
	base := t.TempDir()
	executable := filepath.Join(base, "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs")
	builtin := filepath.Join(filepath.Dir(executable), "..", "config", "provider", "zcode-builtin.json")
	if err := os.MkdirAll(filepath.Dir(builtin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(builtin, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	configRoot := filepath.Join(base, ".zcode", "v2")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	source := []byte(`{"provider":{
		"builtin:bigmodel-coding-plan":{"enabled":true,"kind":"anthropic","options":{"apiKey":"test-secret","baseURL":"https://example.invalid"},"models":{"m":{"limit":{"context":12000}}}},
		"builtin:bigmodel-start-plan":{"enabled":true,"options":{"apiKey":"identity-token"},"models":{"m":{}}},
		"builtin:zai-start-plan":{"enabled":true,"options":{"apiKey":"identity-token"},"models":{"m":{}}},
		"disabled":{"enabled":false,"options":{"apiKey":"disabled-secret"},"models":{"m":{}}}
	}}`)
	file := filepath.Join(configRoot, "config.json")
	if err := os.WriteFile(file, source, 0o600); err != nil {
		t.Fatal(err)
	}
	native := []byte(`{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[{"providerId":"existing","templateId":"bigmodel-api","config":{"access":{"type":"zhipu-coding-plan-api-key","apiKey":"native-secret"}}}]},"modelConfigRules":{"providerModelRules":[]},"defaultModelSelection":{"providerId":"existing","modelId":"GLM-5.3"}}}`)
	nativePath := filepath.Join(configRoot, "provider_config.json")
	if err := os.WriteFile(nativePath, native, 0o600); err != nil {
		t.Fatal(err)
	}
	env, cleanup, err := prepareZcodeRuntimeEnv(executable, []string{"ZCODE_DATA_BASE_DIR=" + base})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	snapshot := zcodeEnvValue(env, zcodePersonalConfigEnv)
	if snapshot == "" || snapshot == nativePath {
		t.Fatal("expected a separate process-owned snapshot")
	}
	info, err := os.Stat(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("provider snapshot mode = %v", info.Mode())
	}
	data, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Config struct {
			Providers struct {
				Rules []json.RawMessage `json:"providerRules"`
			} `json:"providerConfigRules"`
		} `json:"config"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Config.Providers.Rules) != 2 || !strings.Contains(string(data), "test-secret") || strings.Contains(string(data), "identity-token") || strings.Contains(string(data), "disabled-secret") {
		t.Fatal("snapshot must preserve native providers and import only enabled API connections")
	}
	var before, after map[string]any
	if err := json.Unmarshal(native, &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &after); err != nil {
		t.Fatal(err)
	}
	beforeConfig, afterConfig := before["config"].(map[string]any), after["config"].(map[string]any)
	beforeRules := beforeConfig["providerConfigRules"].(map[string]any)["providerRules"].([]any)
	afterRules := afterConfig["providerConfigRules"].(map[string]any)["providerRules"].([]any)
	if !reflect.DeepEqual(beforeRules, afterRules[:len(beforeRules)]) || !reflect.DeepEqual(beforeConfig["defaultModelSelection"], afterConfig["defaultModelSelection"]) {
		t.Fatal("native provider rules and default model selection must be preserved")
	}
	if after, _ := os.ReadFile(file); string(after) != string(source) {
		t.Fatal("Desktop source was modified")
	}
	if after, _ := os.ReadFile(nativePath); string(after) != string(native) {
		t.Fatal("native repository was modified")
	}
	cleanup()
	if _, err := os.Stat(snapshot); !os.IsNotExist(err) {
		t.Fatal("provider snapshot was not removed")
	}
}

func TestZcodeExplicitProviderRepositoryRemainsAuthoritative(t *testing.T) {
	env := []string{zcodePersonalConfigEnv + "=/explicit/providers.json", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/explicit/builtin.json"}
	got, cleanup, err := prepareZcodeRuntimeEnv("/app/zcode.cjs", env)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if strings.Join(got, "\n") != strings.Join(env, "\n") {
		t.Fatal("explicit repository was replaced")
	}
}

func TestCleanupStaleZcodeProviderSnapshotsRemovesLeftovers(t *testing.T) {
	base := t.TempDir()
	t.Setenv("TMPDIR", base)
	// os.TempDir on Unix reads TMPDIR; recreate the leftover layout.
	leftover := filepath.Join(base, zcodeProvidersTempPrefix+"orphan123")
	if err := os.MkdirAll(leftover, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(leftover, "providers.json")
	if err := os.WriteFile(secret, []byte(`{"apiKey":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Unrelated temp dir must survive.
	keep := filepath.Join(base, "unrelated-temp")
	if err := os.MkdirAll(keep, 0o700); err != nil {
		t.Fatal(err)
	}
	removed := CleanupStaleZcodeProviderSnapshots()
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Fatalf("leftover still present: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("unrelated dir was removed: %v", err)
	}
}

func TestRequireNodeForZcodeScript(t *testing.T) {
	if err := requireNodeForZcodeScript(filepath.Join(t.TempDir(), "zcode")); err != nil {
		t.Fatalf("native path should pass: %v", err)
	}
	origPath := os.Getenv("PATH")
	t.Cleanup(func() { os.Setenv("PATH", origPath) })
	t.Setenv("PATH", t.TempDir()) // empty of node
	err := requireNodeForZcodeScript("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")
	if err == nil {
		t.Fatal("expected error when node is missing")
	}
	if !strings.Contains(err.Error(), "Node.js") || !strings.Contains(err.Error(), "node was not found") {
		t.Fatalf("error = %q, want clear Node.js message", err)
	}
}

func zcodeFixtureRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func writeZcodeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestZcodeScriptEntrypointsImportDesktopConnections(t *testing.T) {
	for _, entry := range []string{"direct cjs", "symlink cjs", "symlink mjs", "shell wrapper"} {
		t.Run(entry, func(t *testing.T) {
			if runtime.GOOS == "windows" && strings.HasPrefix(entry, "symlink") {
				t.Skip("symlinks need extra privileges on Windows")
			}
			root := filepath.Join(zcodeFixtureRoot(t), "My Apps")
			script := filepath.Join(root, "resources", "glm", "zcode.cjs")
			if entry == "symlink mjs" {
				script = filepath.Join(filepath.Dir(script), "zcode.mjs")
			}
			builtin := filepath.Join(root, "resources", "config", "provider", "zcode-builtin.json")
			writeZcodeFixture(t, script, "")
			writeZcodeFixture(t, builtin, "{}")
			writeZcodeFixture(t, filepath.Join(root, ".zcode", "v2", "config.json"), `{"provider":{"builtin:bigmodel-coding-plan":{"enabled":true,"kind":"anthropic","options":{"apiKey":"test-secret"},"models":{"GLM-5.3":{}}}}}`)
			executable := script
			if entry != "direct cjs" {
				executable = filepath.Join(root, "bin", "zcode")
				if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
					t.Fatal(err)
				}
				if entry == "shell wrapper" {
					writeZcodeFixture(t, executable, "#!/bin/sh\nexec node \""+script+"\" \"$@\"\n")
				} else if err := os.Symlink(script, executable); err != nil {
					t.Fatal(err)
				}
			}
			env, cleanup, err := prepareZcodeRuntimeEnv(executable, []string{"ZCODE_DATA_BASE_DIR=" + root})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(cleanup)
			if got := zcodeEnvValue(env, "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"); got != builtin {
				t.Fatalf("builtin config = %q, want %q", got, builtin)
			}
			data, err := os.ReadFile(zcodeEnvValue(env, zcodePersonalConfigEnv))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(data), "test-secret") {
				t.Fatal("enabled Desktop connection was not imported")
			}
		})
	}
}

func TestZcodeDesktopProviderAccessTypes(t *testing.T) {
	for _, tc := range []struct{ sourceID, accessType string }{
		{"builtin:bigmodel-coding-plan", "zhipu-coding-plan-api-key"},
		{"builtin:zai-coding-plan", "zhipu-coding-plan-api-key"},
		{"custom", "api-key"},
		{"custom-coding-plan", "api-key"},
		{"builtin:bigmodel", "api-key"},
	} {
		sourceID := tc.sourceID
		t.Run(sourceID, func(t *testing.T) {
			root := t.TempDir()
			script := filepath.Join(root, "glm", "zcode.cjs")
			writeZcodeFixture(t, filepath.Join(root, "config", "provider", "zcode-builtin.json"), "{}")
			writeZcodeFixture(t, filepath.Join(root, ".zcode", "v2", "config.json"), `{"provider":{"`+sourceID+`":{"enabled":true,"kind":"anthropic","options":{"apiKey":"test-secret"},"models":{"GLM-5.3":{}}}}}`)
			env, cleanup, err := prepareZcodeRuntimeEnv(script, []string{"ZCODE_DATA_BASE_DIR=" + root})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(cleanup)
			var snapshot struct {
				Config struct {
					Providers struct {
						Rules []struct {
							Config struct {
								Access struct{ Type, APIKey string }
							}
						} `json:"providerRules"`
					} `json:"providerConfigRules"`
				}
			}
			if err := readZcodeConfig(zcodeEnvValue(env, zcodePersonalConfigEnv), &snapshot); err != nil {
				t.Fatal(err)
			}
			if len(snapshot.Config.Providers.Rules) != 1 {
				t.Fatal("expected one imported provider")
			}
			access := snapshot.Config.Providers.Rules[0].Config.Access
			if access.Type != tc.accessType || access.APIKey != "test-secret" {
				t.Fatalf("access = %+v, want type %q with original key", access, tc.accessType)
			}
		})
	}
}

func TestZcodeLauncherResolutionBoundaries(t *testing.T) {
	root := zcodeFixtureRoot(t)
	script := filepath.Join(root, "zcode.cjs")
	writeZcodeFixture(t, script, "")
	for name, content := range map[string]string{
		"native":   "\x7fELF " + script,
		"missing":  "#!/bin/sh\nexec node '" + filepath.Join(root, "missing.cjs") + "'",
		"relative": "#!/bin/sh\nexec node zcode.cjs",
		"comment":  "#!/bin/sh\n# " + script + "\nexec zcode-native",
		"large":    "#!/bin/sh\n" + strings.Repeat("# padding\n", 8<<10) + "exec node '" + script + "'",
	} {
		t.Run(name, func(t *testing.T) {
			executable := filepath.Join(root, name)
			writeZcodeFixture(t, executable, content)
			if got := resolveZcodeScript(executable); got != executable {
				t.Fatalf("resolved %q, want original %q", got, executable)
			}
		})
	}
}

func TestZcodeBuiltinProviderConfigLayouts(t *testing.T) {
	for _, layout := range []string{"desktop", "cli bundle", "standalone"} {
		t.Run(layout, func(t *testing.T) {
			root := t.TempDir()
			script := filepath.Join(root, "bin", "zcode.mjs")
			var builtin string
			switch layout {
			case "desktop":
				builtin = filepath.Join(root, "config", "provider", "zcode-builtin.json")
			case "cli bundle":
				builtin = filepath.Join(root, "bin", "provider", "zcode-builtin.json")
			case "standalone":
				builtin = filepath.Join(root, "agent", "provider", "zcode-builtin.json")
			}
			writeZcodeFixture(t, builtin, "{}")
			if got := zcodeBuiltinProviderConfig(script); got != builtin {
				t.Fatalf("builtin config = %q, want %q", got, builtin)
			}
			env := []string{"ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/explicit/builtin.json"}
			if got := zcodeRuntimeEnv(script, env); !reflect.DeepEqual(got, env) {
				t.Fatal("explicit builtin configuration was replaced")
			}
		})
	}
}
