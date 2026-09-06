//go:build linux

package daemon

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Linux identity proofs for the Kimi local server, all from /proc:
// socket ownership via /proc/net/tcp{,6} (the kernel records the listening
// socket's uid), process ownership via /proc/<pid>/status, and a process-name
// sanity check via /proc/<pid>/exe. The token file is 0600 same-user, so the
// trust boundary being enforced here is exactly "same user".

func kimiIdentitySupported() bool { return true }

// kimiSocketOwnedByUser reports whether the port's LISTEN socket belongs to
// this process's effective user.
func kimiSocketOwnedByUser(port int) bool {
	var tables [][]byte
	for _, name := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if raw, err := os.ReadFile(name); err == nil {
			tables = append(tables, raw)
		}
	}
	return portListenOwnedByUID(port, os.Geteuid(), tables)
}

// portListenOwnedByUID scans kernel TCP tables for LISTEN sockets bound to
// the port. It answers false when nothing listens (a cheap pre-dial filter)
// or when ANY listener on the port belongs to a different uid.
func portListenOwnedByUID(port, uid int, tables [][]byte) bool {
	found := false
	for _, table := range tables {
		for i, line := range strings.Split(string(table), "\n") {
			if i == 0 { // header row
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 8 {
				continue
			}
			// local_address is hex ip:hex port; st 0A is LISTEN; uid is field 7.
			_, hexPort, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			p, err := strconv.ParseUint(hexPort, 16, 32)
			if err != nil || int(p) != port {
				continue
			}
			if fields[3] != "0A" {
				continue
			}
			found = true
			socketUID, err := strconv.Atoi(fields[7])
			if err != nil || socketUID != uid {
				return false
			}
		}
	}
	return found
}

// kimiVerifyInstanceProcess binds a registry-claimed pid to a live, same-user
// process whose executable looks like the Kimi CLI. Anything else — dead pid,
// foreign owner, unrelated image (e.g. a recycled pid) — is an error, and the
// caller moves on without sending credentials.
func kimiVerifyInstanceProcess(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return fmt.Errorf("process not readable: %w", err)
	}
	uid := -1
	for _, line := range strings.Split(string(status), "\n") {
		if rest, ok := strings.CutPrefix(line, "Uid:"); ok {
			fields := strings.Fields(rest)
			if len(fields) > 0 {
				uid, _ = strconv.Atoi(fields[0]) // real uid
			}
			break
		}
	}
	if uid < 0 {
		return fmt.Errorf("process %d: no uid in status", pid)
	}
	if uid != os.Geteuid() {
		return fmt.Errorf("process %d owned by uid %d, want %d", pid, uid, os.Geteuid())
	}
	// The CLI may be a native binary or a Node script (whose exe is "node"),
	// so accept a kimi-ish image OR a kimi-ish command line.
	exe, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	haystack := strings.ToLower(exe + " " + strings.ReplaceAll(string(cmdline), "\x00", " "))
	if !strings.Contains(haystack, "kimi") {
		return fmt.Errorf("process %d image %q is not kimi", pid, strings.TrimSpace(haystack))
	}
	return nil
}
