//go:build windows

package agent

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// antigravityQuotaProcessesImpl lists the pids of running agy processes via
// tasklist's image-name filter (built into every supported Windows release,
// locale-independent CSV output). Only an image-name match is available here
// — tasklist does not expose command lines — so a same-named unrelated binary
// can produce a candidate; the RPC-level parse is what disqualifies it, and a
// failed probe is silent by contract. Best-effort: a failing tasklist yields
// no candidates. The scan derives its budget from the caller's context, so a
// caller deadline cancels the subprocess instead of outliving it.
func antigravityQuotaProcessesImpl(ctx context.Context, execPath string) []int {
	if ctx.Err() != nil {
		return nil
	}
	image := filepath.Base(execPath)
	if !strings.HasSuffix(strings.ToLower(image), ".exe") {
		// tasklist matches image names as the process reports them, and
		// Windows CLIs carry .exe even when the daemon resolved a bare name.
		image += ".exe"
	}
	ctx, cancel := context.WithTimeout(ctx, antigravityQuotaPSBudget)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tasklist", "/FI", "IMAGENAME eq "+image, "/FO", "CSV", "/NH").Output()
	if err != nil {
		return nil
	}
	// The image filter already scoped the rows; the shared CSV parser turns
	// them into PIDs (one record per running instance).
	return parseAntigravityTasklistPIDs(string(out))
}

// listeningLoopbackPorts returns the TCP ports one process owns, from netstat
// -ano (built into every supported Windows release). Both listeners and
// established sockets are collected — the caller's dial decides reachability,
// and a non-listening port simply fails its RPC attempt. The scan derives its
// budget from the caller's context, so a caller deadline cancels the
// subprocess instead of outliving it.
func listeningLoopbackPorts(ctx context.Context, pid int) []int {
	if ctx.Err() != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, antigravityQuotaPSBudget)
	defer cancel()
	out, err := exec.CommandContext(ctx, "netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return nil
	}
	return parseAntigravityNetstatPorts(string(out), pid)
}

// antigravityQuotaPSBudget bounds each tasklist/netstat call inside a probe
// round; both are subsecond tools on a healthy machine.
const antigravityQuotaPSBudget = 2 * time.Second
