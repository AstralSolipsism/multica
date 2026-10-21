package daemon

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
)

func TestLoadConfig_JevDefaultsAndOverrides(t *testing.T) {
	stageFakeAgent(t)
	redirectTestHome(t, t.TempDir())
	t.Setenv("SHELL", filepath.Join(t.TempDir(), "missing-shell"))
	for _, kv := range []string{
		"MULTICA_JEV_DISABLED=",
		"MULTICA_JEV_SOURCES=",
		"MULTICA_JEV_TIMEOUT_MS=",
		"MULTICA_JEV_OPENCODE_API_KEY=",
		"MULTICA_JEV_DASHSCOPE_API_KEY=",
		"MULTICA_JEV_DASHSCOPE_WORKSPACE_ID=",
		"MULTICA_JEV_DASHSCOPE_REGION=",
	} {
		t.Setenv(kv[:len(kv)-1], "")
	}

	overrides := Overrides{
		ServerURL:      "http://localhost:0",
		WorkspacesRoot: t.TempDir(),
	}

	cfg, err := LoadConfig(overrides)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.JevDisabled {
		t.Fatal("JevDisabled default = true, want false")
	}
	if cfg.JevTimeout != jev.DefaultTimeout {
		t.Fatalf("JevTimeout = %s, want %s", cfg.JevTimeout, jev.DefaultTimeout)
	}
	if len(cfg.JevSources) != 1 || cfg.JevSources[0].Name != "opencode-free" {
		t.Fatalf("JevSources = %+v, want default [opencode-free]", cfg.JevSources)
	}
	if cfg.JevSources[0].BearerToken != "" {
		t.Fatal("opencode-free must be unauthenticated")
	}

	// Overrides: disabled flag, timeout, ordered sources with credentials.
	t.Setenv("MULTICA_JEV_DISABLED", "1")
	t.Setenv("MULTICA_JEV_TIMEOUT_MS", "250")
	t.Setenv("MULTICA_JEV_SOURCES", "dashscope,opencode,opencode-free,unknown")
	t.Setenv("MULTICA_JEV_DASHSCOPE_API_KEY", "sk-test-dashscope")
	t.Setenv("MULTICA_JEV_DASHSCOPE_WORKSPACE_ID", "ws-9")
	t.Setenv("MULTICA_JEV_OPENCODE_API_KEY", "sk-test-opencode")
	cfg, err = LoadConfig(overrides)
	if err != nil {
		t.Fatalf("LoadConfig with Jev env: %v", err)
	}
	if !cfg.JevDisabled {
		t.Fatal("JevDisabled = false, want true")
	}
	if cfg.JevTimeout != 250*time.Millisecond {
		t.Fatalf("JevTimeout = %s, want 250ms", cfg.JevTimeout)
	}
	if len(cfg.JevSources) != 3 {
		t.Fatalf("JevSources = %+v, want 3 (dashscope, opencode, opencode-free; unknown skipped)", cfg.JevSources)
	}
	if cfg.JevSources[0].Name != "dashscope" || cfg.JevSources[0].BearerToken != "sk-test-dashscope" {
		t.Fatalf("dashscope source = %+v", cfg.JevSources[0])
	}
	if !strings.Contains(cfg.JevSources[0].BaseURL, "ws-9.cn-beijing.maas.aliyuncs.com") {
		t.Fatalf("dashscope base URL = %s", cfg.JevSources[0].BaseURL)
	}
	if cfg.JevSources[1].Name != "opencode" || cfg.JevSources[1].BearerToken != "sk-test-opencode" {
		t.Fatalf("opencode source = %+v", cfg.JevSources[1])
	}
	if cfg.JevSources[2].Name != "opencode-free" || cfg.JevSources[2].BearerToken != "" {
		t.Fatalf("opencode-free source = %+v", cfg.JevSources[2])
	}
	if cfg.JevSourceEnv.DashScopeRegion != "" {
		t.Fatalf("DashScopeRegion = %q, want empty default", cfg.JevSourceEnv.DashScopeRegion)
	}

	// Invalid timeout fails config loading with a named error.
	t.Setenv("MULTICA_JEV_TIMEOUT_MS", "not-a-number")
	if _, err := LoadConfig(overrides); err == nil || !strings.Contains(err.Error(), "MULTICA_JEV_TIMEOUT_MS") {
		t.Fatalf("invalid timeout error = %v, want named validation error", err)
	}
}
