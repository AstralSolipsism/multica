package daemon

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/daemon/media"
)

func (d *Daemon) initMediaRegistry(ctx context.Context) error {
	root, err := cli.ProfileDir("")
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	r, err := media.Discover(root, home, d.cfg.Profile)
	if err != nil {
		d.logger.Warn("media discovery unavailable", "error", err)
		return nil
	}
	d.mediaRegistry = r
	d.client.mediaConnectionID = r.Snapshot().ConnectionID
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.Refresh(ctx)
			}
		}
	}()
	return nil
}
func (d *Daemon) mediaRegistrationEntries(entries []map[string]string) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		row := make(map[string]any, len(entry)+1)
		for k, v := range entry {
			row[k] = v
		}
		if entry["type"] == "media" && d.mediaRegistry != nil {
			row["media_executors"] = d.mediaRegistry.Snapshot()
		}
		out = append(out, row)
	}
	return out
}

// Media runtimes participate in heartbeat discovery, never agent task claims.
func (d *Daemon) agentRuntimeIDs() []string {
	ids := d.allRuntimeIDs()
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if rt := d.findRuntime(id); rt != nil && rt.Provider != "media" {
			out = append(out, id)
		}
	}
	return out
}

// Provisioned browser/media storage lets a dedicated host start without a
// coding CLI. This check does not advertise readiness or read credentials.
func hasProvisionedMediaProfile(profile string) bool {
	root, err := cli.ProfileDir(profile)
	if err != nil {
		return false
	}
	for _, provider := range []string{"codex", "agy", "google-browser"} {
		if info, err := os.Stat(filepath.Join(root, "media", "native", provider)); err == nil && info.IsDir() {
			return true
		}
	}
	return false
}
