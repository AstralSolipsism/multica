package daemon

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/media"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestDaemonMediaRegistrationIsPerRuntime(t *testing.T) {
	p, err := media.OpenProfile(t.TempDir(), t.TempDir(), "sub", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	registry := media.NewRegistry([]media.Instance{{Profile: p}})
	registry.Refresh(context.Background())
	d := &Daemon{mediaRegistry: registry}
	rows := d.mediaRegistrationEntries([]map[string]string{{"type": "codex"}, {"type": "antigravity"}, {"type": "media", "kind": "media"}})
	if rows[0]["media_executors"] != nil || rows[1]["media_executors"] != nil {
		t.Fatal("native capabilities broadcast to coding runtimes")
	}
	report, ok := rows[2]["media_executors"].(*protocol.MediaExecutorReport)
	if !ok || len(report.Executors) != 1 || report.Executors[0].ExecutorID != p.ExecutorID {
		t.Fatal("missing media inventory")
	}
}
func TestDaemonMediaHostDoesNotRequireCodingCLI(t *testing.T) {
	t.Setenv("MULTICA_TASK_CONFIG_ROOT", t.TempDir())
	// The configuration-only check must not create native storage or credentials.
	if hasProvisionedMediaProfile("sub") {
		t.Fatal("unprovisioned media host detected")
	}
	root := os.Getenv("MULTICA_TASK_CONFIG_ROOT")
	if err := os.MkdirAll(filepath.Join(root, "profiles", "sub", "media", "native", "google-browser"), 0700); err != nil {
		t.Fatal(err)
	}
	if !hasProvisionedMediaProfile("sub") {
		t.Fatal("media-only host needs coding CLI")
	}
}
