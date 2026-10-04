//go:build agentintegration

package daemon

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func livePlanQuotaHome(t *testing.T) string {
	t.Helper()
	if os.Getenv("MULTICA_RUN_REAL_AGENT_SMOKE") != "1" {
		t.Skip("set MULTICA_RUN_REAL_AGENT_SMOKE=1 to allow real provider account access")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	return home
}

func assertFreshLivePlanQuota(t *testing.T, quota *protocol.RuntimePlanQuota, started time.Time) {
	t.Helper()
	if quota == nil || len(quota.Windows) == 0 || quota.ObservedAt < started.Unix() || time.Now().Unix()-quota.ObservedAt >= 300 {
		t.Fatal("collector did not produce a fresh nonempty snapshot")
	}
	// Log only observation metadata; credentials and account details stay local.
	t.Logf("provider=%s observed_at=%s windows=%d", quota.Provider, time.Unix(quota.ObservedAt, 0).UTC().Format(time.RFC3339), len(quota.Windows))
}

func TestKimiPlanQuotaLive(t *testing.T) {
	home := livePlanQuotaHome(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	collector := newKimiPlanQuotaCollector(filepath.Join(home, kimiServerHomeDir))
	defer collector.client.CloseIdleConnections()
	started := time.Now()
	quota, err := collector.collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertFreshLivePlanQuota(t, quota, started)
}

func TestAntigravityPlanQuotaLive(t *testing.T) {
	home := livePlanQuotaHome(t)
	path, err := exec.LookPath("agy")
	if err != nil {
		t.Fatal("agy must be installed and signed in for this smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	version, err := agent.DetectVersion(ctx, agent.Command{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	collector := newAntigravityPlanQuotaCollector(home)
	defer collector.client.CloseIdleConnections()
	started := time.Now()
	quota, err := collector.collect(ctx, version)
	if err != nil {
		t.Fatal(err)
	}
	assertFreshLivePlanQuota(t, quota, started)
}
