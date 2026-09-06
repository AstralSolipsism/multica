//go:build !linux && !windows

package agent

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// antigravityQuotaProcessesImpl lists the pids of running agy processes whose
// command line matches the daemon's resolved executable (absolute path or
// basename), via one `ps` scan. Best-effort: a failing ps yields no
// candidates, which the caller reports as "no running agy process".
func antigravityQuotaProcessesImpl(execPath string) []int {
	// `-ax -o pid=,command=` works on both BSD ps (macOS) and procps: every
	// process, no header, pid first and the full command line after.
	ctx, cancel := context.WithTimeout(context.Background(), antigravityQuotaPSBudget)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-ax", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	base := filepath.Base(execPath)
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.TrimSpace(line)
		if fields == "" {
			continue
		}
		pidText, command, ok := strings.Cut(fields, " ")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(pidText))
		if err != nil {
			continue
		}
		if antigravityExecutableMatches(strings.Fields(command), execPath, base) {
			pids = append(pids, pid)
		}
	}
	return pids
}

// listeningLoopbackPorts returns the TCP ports one process is listening on,
// discovered with lsof (shipped with macOS and the BSDs). -nP skips name
// resolution so the parse sees raw addresses/ports; the NAME column is the
// last field, so trailing whitespace never breaks it.
func listeningLoopbackPorts(pid int) []int {
	ctx, cancel := context.WithTimeout(context.Background(), antigravityQuotaPSBudget)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p",
		strconv.Itoa(pid)).Output()
	if err != nil {
		return nil
	}
	seen := make(map[int]bool)
	var ports []int
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME, with
		// lsof appending a separate ` (LISTEN)` state field on some releases.
		// NAME is therefore field 8, not the last field. The header line has
		// no NAME column and is dropped by the field-count check.
		if len(fields) < 9 || fields[7] != "TCP" {
			continue
		}
		name := fields[8]
		// The port follows the LAST colon: the host part may itself contain
		// colons for IPv6 names like `[::1]:5252`.
		idx := strings.LastIndex(name, ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.ParseUint(name[idx+1:], 10, 16)
		if err != nil || port == 0 || seen[int(port)] {
			continue
		}
		seen[int(port)] = true
		ports = append(ports, int(port))
	}
	return ports
}

// antigravityQuotaPSBudget bounds each ps/lsof call inside a probe round.
// These are subsecond tools on a healthy machine; the cap exists so a wedged
// subprocess cannot eat the whole round budget on its own.
const antigravityQuotaPSBudget = 2 * time.Second
