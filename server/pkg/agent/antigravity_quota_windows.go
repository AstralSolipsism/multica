//go:build windows

package agent

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// antigravityQuotaProcessesImpl lists the pids of running agy processes via
// tasklist's image-name filter (built into every supported Windows release,
// locale-independent CSV output). Only an image-name match is available here
// — tasklist does not expose command lines — so a same-named unrelated binary
// can produce a candidate; the RPC-level parse is what disqualifies it, and a
// failed probe is silent by contract. Best-effort: a failing tasklist yields
// no candidates.
func antigravityQuotaProcessesImpl(execPath string) []int {
	image := filepath.Base(execPath)
	if !strings.HasSuffix(strings.ToLower(image), ".exe") {
		// tasklist matches image names as the process reports them, and
		// Windows CLIs carry .exe even when the daemon resolved a bare name.
		image += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), antigravityQuotaPSBudget)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tasklist", "/FI", "IMAGENAME eq "+image, "/FO", "CSV", "/NH").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, record := range csvRecords(string(out)) {
		// CSV columns: "image","pid","session name","session #","mem usage".
		if len(record) < 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(record[1]))
		if err != nil {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

// listeningLoopbackPorts returns the TCP ports one process owns, from netstat
// -ano (built into every supported Windows release). Both listeners and
// established sockets are collected — the caller's dial decides reachability,
// and a non-listening port simply fails its RPC attempt. Column positions are
// stable across locales; the state TEXT is not, so the parse is structural:
// proto=TCP, local address second-to... last-but-one, owning PID last.
func listeningLoopbackPorts(pid int) []int {
	ctx, cancel := context.WithTimeout(context.Background(), antigravityQuotaPSBudget)
	defer cancel()
	out, err := exec.CommandContext(ctx, "netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return nil
	}
	want := strconv.Itoa(pid)
	seen := make(map[int]bool)
	var ports []int
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// Active Connections rows: Proto Local Foreign State PID. The header
		// line has four fields and no PID, so the count check drops it.
		if len(fields) != 5 || !strings.EqualFold(fields[0], "TCP") {
			continue
		}
		if fields[4] != want {
			continue
		}
		// Local address carries the port after its last colon.
		idx := strings.LastIndex(fields[1], ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.ParseUint(fields[1][idx+1:], 10, 16)
		if err != nil || port == 0 || seen[int(port)] {
			continue
		}
		seen[int(port)] = true
		ports = append(ports, int(port))
	}
	return ports
}

// csvRecords splits the RFC-4180-ish single-line records tasklist emits,
// honoring its doubled-quote escaping. tasklist only ever prints plain
// cells, so a minimal splitter is enough — a malformed line yields no record
// rather than a wrong pid.
func csvRecords(data string) [][]string {
	var records [][]string
	for _, line := range strings.Split(strings.ReplaceAll(data, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "\"") {
			continue
		}
		var (
			record []string
			cell   strings.Builder
			inCell bool
		)
		for i := 0; i < len(line); i++ {
			switch line[i] {
			case '"':
				if inCell && i+1 < len(line) && line[i+1] == '"' {
					cell.WriteByte('"')
					i++
					continue
				}
				if inCell {
					records = append(records, append(record, cell.String()))
					record = nil
					cell.Reset()
					inCell = false
					continue
				}
				inCell = true
			default:
				if inCell {
					cell.WriteByte(line[i])
				}
			}
		}
		if inCell && cell.Len() > 0 {
			records = append(records, append(record, cell.String()))
		}
	}
	return records
}

// antigravityQuotaPSBudget bounds each tasklist/netstat call inside a probe
// round; both are subsecond tools on a healthy machine.
const antigravityQuotaPSBudget = 2 * time.Second
