//go:build agentintegration

package agent

import (
	"context"
	"image"
	_ "image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexNativeImageLive(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("set MULTICA_RUN_REAL_AGENT_SMOKE=1 to use the host subscription")
	}
	path, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	home := os.Getenv("CODEX_HOME")
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			t.Fatal(err)
		}
		home = filepath.Join(h, ".codex")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	command := NewCommand(path, nil)
	if err := ProbeCodexImages(ctx, command, home); err != nil {
		t.Fatal(err)
	}
	var inputs []string
	for _, prompt := range []string{"Generate exactly one image: a solid blue circle on a white background. No text.", "Edit the attached image. Change the blue circle to red, preserving the white background. Produce exactly one image."} {
		result, err := GenerateCodexImage(ctx, command, home, t.TempDir(), prompt, inputs)
		if err != nil || result.RateLimited {
			t.Fatalf("native generation failed: %v limited=%v", err, result.RateLimited)
		}
		f, err := os.Open(result.Path)
		if err != nil {
			t.Fatal(err)
		}
		cfg, format, err := image.DecodeConfig(f)
		_ = f.Close()
		if err != nil || cfg.Width < 1 || cfg.Height < 1 {
			t.Fatalf("invalid native image: %v", err)
		}
		t.Logf("reference_images=%d format=%s dimensions=%dx%d", len(inputs), format, cfg.Width, cfg.Height)
		inputs = []string{result.Path}
	}
}
