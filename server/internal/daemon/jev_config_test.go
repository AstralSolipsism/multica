package daemon

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/internal/daemon/jevsample"
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
		"MULTICA_JEV_SELF_HOSTED_URL=",
		"MULTICA_JEV_SELF_HOSTED_MODEL=",
		"MULTICA_JEV_SELF_HOSTED_API_KEY=",
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
	t.Setenv("MULTICA_JEV_SOURCES", "self-hosted,dashscope,opencode,opencode-free,unknown")
	t.Setenv("MULTICA_JEV_SELF_HOSTED_URL", "http://127.0.0.1:8009/v1/systemone")
	t.Setenv("MULTICA_JEV_SELF_HOSTED_MODEL", "jev-finetune-1")
	t.Setenv("MULTICA_JEV_SELF_HOSTED_API_KEY", "sk-test-selfhosted")
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
	if len(cfg.JevSources) != 4 {
		t.Fatalf("JevSources = %+v, want 4 (self-hosted, dashscope, opencode, opencode-free; unknown skipped)", cfg.JevSources)
	}
	if cfg.JevSources[0].Name != "self-hosted" || cfg.JevSources[0].BaseURL != "http://127.0.0.1:8009/v1/systemone" {
		t.Fatalf("self-hosted source = %+v", cfg.JevSources[0])
	}
	if cfg.JevSources[0].Model != "jev-finetune-1" || cfg.JevSources[0].BearerToken != "sk-test-selfhosted" {
		t.Fatalf("self-hosted source = %+v, want configured model and key", cfg.JevSources[0])
	}
	if cfg.JevSources[1].Name != "dashscope" || cfg.JevSources[1].BearerToken != "sk-test-dashscope" {
		t.Fatalf("dashscope source = %+v", cfg.JevSources[1])
	}
	if !strings.Contains(cfg.JevSources[1].BaseURL, "ws-9.cn-beijing.maas.aliyuncs.com") {
		t.Fatalf("dashscope base URL = %s", cfg.JevSources[1].BaseURL)
	}
	if cfg.JevSources[2].Name != "opencode" || cfg.JevSources[2].BearerToken != "sk-test-opencode" {
		t.Fatalf("opencode source = %+v", cfg.JevSources[2])
	}
	if cfg.JevSources[3].Name != "opencode-free" || cfg.JevSources[3].BearerToken != "" {
		t.Fatalf("opencode-free source = %+v", cfg.JevSources[3])
	}
	if cfg.JevSourceEnv.DashScopeRegion != "" {
		t.Fatalf("DashScopeRegion = %q, want empty default", cfg.JevSourceEnv.DashScopeRegion)
	}

	// Invalid timeout fails config loading with a named error.
	t.Setenv("MULTICA_JEV_TIMEOUT_MS", "not-a-number")
	if _, err := LoadConfig(overrides); err == nil || !strings.Contains(err.Error(), "MULTICA_JEV_TIMEOUT_MS") {
		t.Fatalf("invalid timeout error = %v, want named validation error", err)
	}

	t.Setenv("MULTICA_JEV_TIMEOUT_MS", "")
	// Sample collection defaults to off with the default cap; overrides work
	// and an invalid cap is a named validation error.
	t.Setenv("MULTICA_JEV_COLLECT_DIR", "")
	t.Setenv("MULTICA_JEV_COLLECT_MAX_MB", "")
	cfg, err = LoadConfig(overrides)
	if err != nil {
		t.Fatalf("LoadConfig collect defaults: %v", err)
	}
	if cfg.JevCollectDir != "" || cfg.JevCollectMaxBytes != int64(jevsample.DefaultMaxMB)<<20 {
		t.Fatalf("collect defaults: dir=%q max=%d", cfg.JevCollectDir, cfg.JevCollectMaxBytes)
	}
	t.Setenv("MULTICA_JEV_COLLECT_DIR", " /var/lib/multica/samples ")
	t.Setenv("MULTICA_JEV_COLLECT_MAX_MB", "2")
	cfg, err = LoadConfig(overrides)
	if err != nil {
		t.Fatalf("LoadConfig collect overrides: %v", err)
	}
	if cfg.JevCollectDir != "/var/lib/multica/samples" || cfg.JevCollectMaxBytes != 2<<20 {
		t.Fatalf("collect overrides: dir=%q max=%d", cfg.JevCollectDir, cfg.JevCollectMaxBytes)
	}
	t.Setenv("MULTICA_JEV_COLLECT_MAX_MB", "not-a-number")
	if _, err := LoadConfig(overrides); err == nil || !strings.Contains(err.Error(), "MULTICA_JEV_COLLECT_MAX_MB") {
		t.Fatalf("invalid cap error = %v, want named validation error", err)
	}
}
